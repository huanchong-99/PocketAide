"""本地嵌入封装 —— 优先走常驻守护进程，秒回；否则进程内加载保底。

零额外费用、全本地：用 sentence-transformers 加载 BGE 模型。
首选 bge-m3（多语言、中文质量好，维度 1024）；
若不可用回退 FALLBACK_MODEL（bge-small-zh-v1.5，维度 512）。

性能关键：每个 `python kg.py` 新进程都重载 torch+bge-m3 ≈12s，桥接 idle 超时只有
5s，会导致回复被截断。因此 embed() 的调用路径是：
  1) 先尝试连本地守护进程 embed_daemon.py（127.0.0.1:PORT），连上就用它 → 亚秒级。
  2) 连不上就 detached spawn 守护进程（Windows 不弹窗、不阻塞父进程），轮询到 ready 后用它。
  3) 守护进程彻底起不来，再回退当前进程内加载（保底，慢但能用）。

环境变量 KG_EMBED_INPROC=1 时强制进程内加载（守护进程自身就是这么调 embed 的，
避免递归连自己）。
"""

import os
import socket
import struct
import subprocess
import sys
import time

# ---- 模型常量（易改）----
PRIMARY_MODEL = "BAAI/bge-m3"               # 首选：多语言，dim=1024
FALLBACK_MODEL = "BAAI/bge-small-zh-v1.5"   # 回退：中文小模型，dim=512

# 允许用环境变量强制指定模型（自测/调试用）
ENV_MODEL = os.environ.get("KG_EMBED_MODEL", "").strip()

# 守护进程连接配置（与 embed_daemon.py 保持一致）
# 端口避开 Windows Hyper-V 保留区间，见 embed_daemon.py 注释。
DAEMON_HOST = "127.0.0.1"
DAEMON_PORT = int(os.environ.get("KG_EMBED_PORT", "8199"))
# 强制进程内（守护进程自身设置，防止 embed() 递归连自己）
FORCE_INPROC = os.environ.get("KG_EMBED_INPROC", "").strip() in ("1", "true", "True")
# 完全禁用守护进程（调试/自测对照用）
DISABLE_DAEMON = os.environ.get("KG_EMBED_NO_DAEMON", "").strip() in ("1", "true", "True")

SPAWN_WAIT = float(os.environ.get("KG_EMBED_SPAWN_WAIT", "60"))  # 等守护就绪最长秒数
MAX_MSG = 64 * 1024 * 1024

_model = None
_model_name = None
# 守护进程探测过一次后缓存结果，避免每次 embed 都重试 spawn
_daemon_state = None  # None=未探测; True=可用; False=不可用(已回退进程内)


# ====================== 进程内加载（保底路径） ======================
def _try_load(name):
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(name)


def load_model():
    """加载嵌入模型（单例）。首选 PRIMARY，失败回退 FALLBACK。"""
    global _model, _model_name
    if _model is not None:
        return _model

    candidates = []
    if ENV_MODEL:
        candidates.append(ENV_MODEL)
    candidates.append(PRIMARY_MODEL)
    candidates.append(FALLBACK_MODEL)

    last_err = None
    for name in candidates:
        try:
            _model = _try_load(name)
            _model_name = name
            return _model
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"[kg] 加载模型 {name} 失败: {e}", file=sys.stderr)
            continue
    raise RuntimeError(f"所有嵌入模型均加载失败，最后错误: {last_err}")


def _embed_inproc(texts, is_query=False):
    import numpy as np

    model = load_model()
    if isinstance(texts, str):
        texts = [texts]
    vecs = model.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return np.asarray(vecs, dtype=np.float32)


# ====================== 守护进程客户端（快路径） ======================
def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def _rpc(obj, timeout=300):
    """向守护进程发一条请求并读响应。失败抛异常。"""
    import json

    with socket.create_connection((DAEMON_HOST, DAEMON_PORT), timeout=timeout) as s:
        s.settimeout(timeout)
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        s.sendall(struct.pack(">I", len(data)) + data)
        head = _recv_exact(s, 4)
        if head is None:
            raise ConnectionError("守护进程无响应")
        (length,) = struct.unpack(">I", head)
        if length <= 0 or length > MAX_MSG:
            raise ConnectionError(f"守护进程响应长度异常: {length}")
        body = _recv_exact(s, length)
        if body is None:
            raise ConnectionError("守护进程响应不完整")
        return json.loads(body.decode("utf-8"))


def _daemon_ping(timeout=2):
    try:
        resp = _rpc({"cmd": "ping"}, timeout=timeout)
        return bool(resp.get("ok"))
    except Exception:  # noqa: BLE001
        return False


def _spawn_daemon():
    """detached 启动守护进程：Windows 下不弹窗、不阻塞父进程。"""
    daemon_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "embed_daemon.py")
    kwargs = {}
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NO_WINDOW，且不继承父 stdin/stdout
        DETACHED_PROCESS = 0x00000008
        CREATE_NO_WINDOW = 0x08000000
        kwargs["creationflags"] = DETACHED_PROCESS | CREATE_NO_WINDOW
        kwargs["close_fds"] = True
    else:
        kwargs["start_new_session"] = True
        kwargs["close_fds"] = True
    try:
        subprocess.Popen(
            [sys.executable, daemon_py],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[kg] 启动守护进程失败: {e}", file=sys.stderr)
        return False


def _ensure_daemon():
    """确保守护进程可用。返回 True=可用。"""
    global _daemon_state
    if _daemon_state is not None:
        return _daemon_state

    # 已在跑？
    if _daemon_ping():
        _daemon_state = True
        return True

    # 起一个
    if not _spawn_daemon():
        _daemon_state = False
        return False

    # 轮询等就绪（首次要载模型 ≈12s，给足 SPAWN_WAIT）
    deadline = time.time() + SPAWN_WAIT
    while time.time() < deadline:
        if _daemon_ping(timeout=2):
            _daemon_state = True
            return True
        time.sleep(0.5)

    print(f"[kg] 守护进程 {SPAWN_WAIT}s 内未就绪，回退进程内加载", file=sys.stderr)
    _daemon_state = False
    return False


def _embed_via_daemon(texts, is_query=False):
    import numpy as np

    if isinstance(texts, str):
        texts = [texts]
    resp = _rpc({"cmd": "embed", "texts": list(texts), "is_query": bool(is_query)})
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error", "守护进程 embed 失败"))
    global _model_name
    _model_name = resp.get("model", _model_name)
    return np.asarray(resp["vectors"], dtype=np.float32)


# ====================== 对外接口 ======================
def get_model_name():
    """返回当前使用的模型名。优先问守护进程，避免为拿名字而进程内载模型。"""
    global _model_name
    if _model_name is not None:
        return _model_name
    if not FORCE_INPROC and not DISABLE_DAEMON:
        try:
            resp = _rpc({"cmd": "ping"}, timeout=2)
            if resp.get("ok"):
                _model_name = resp.get("model")
                if _model_name:
                    return _model_name
        except Exception:  # noqa: BLE001
            pass
    if _model_name is None:
        load_model()
    return _model_name


def embed(texts, is_query=False):
    """对一批文本编码，返回归一化向量（float32 numpy，shape=[n, dim]）。

    normalize_embeddings=True → 余弦相似度 = 点积。
    路径：守护进程优先 → spawn → 进程内保底。
    """
    if not FORCE_INPROC and not DISABLE_DAEMON:
        if _ensure_daemon():
            try:
                return _embed_via_daemon(texts, is_query=is_query)
            except Exception as e:  # noqa: BLE001
                # 守护进程中途挂了：失效缓存 + 回退进程内
                global _daemon_state
                _daemon_state = False
                print(f"[kg] 守护进程调用失败，回退进程内: {e}", file=sys.stderr)
    return _embed_inproc(texts, is_query=is_query)
