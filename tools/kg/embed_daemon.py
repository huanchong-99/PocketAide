#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""嵌入守护进程：进程内常驻加载一次 bge-m3，通过本地 TCP 提供编码服务。

为什么需要它：每个 `python kg.py` 新进程都重载 torch+bge-m3 ≈12s，而桥接层
（飞书↔伪终端↔claude）idle 超时只有 5s，模型加载期 PTY 静默会被误判为"回复结束"
导致回复截断。让模型常驻、调用秒回即可根治。

协议（length-prefixed JSON over TCP，回环地址）：
  请求：4字节大端无符号长度 + UTF-8 JSON
         {"cmd":"embed","texts":[...],"is_query":bool}
         {"cmd":"ping"}
         {"cmd":"info"}
         {"cmd":"shutdown"}
  响应：4字节大端长度 + UTF-8 JSON
         embed   -> {"ok":true,"model":"...","dim":N,"vectors":[[...],...]}
         ping    -> {"ok":true,"model":"...","ready":true}
         info    -> {"ok":true,"model":"...","dim":N,"pid":...}
         错误    -> {"ok":false,"error":"..."}

空闲超时（IDLE_TIMEOUT 秒无请求）自动退出释放内存。
复用 embedder.py 的 bge-m3（含首选/回退/KG_EMBED_MODEL 覆盖逻辑），不重下、不换模型。
"""

import json
import os
import socket
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# 守护进程内部必须走进程内加载，否则 embedder.embed() 会回头连自己 → 递归。
# 必须在 import embedder 之前设置（FORCE_INPROC 在 import 时读取）。
os.environ["KG_EMBED_INPROC"] = "1"
import embedder  # noqa: E402

# ---- 可配置常量 ----
HOST = "127.0.0.1"
# 注意：Windows 上 Hyper-V/WSL 会保留大量动态端口区间（netsh 可查 excludedportrange），
# 落在其中的端口 bind 会报 WinError 10013（访问权限不允许），即使端口看似空闲。
# 8771 实测落在保留区间 8757-8856，故改用 8199（位于 1456-8256 的空闲区）。
# 改端口时务必避开 excludedportrange，并与 embedder.py 的 DAEMON_PORT 同步。
PORT = int(os.environ.get("KG_EMBED_PORT", "8199"))
IDLE_TIMEOUT = int(os.environ.get("KG_EMBED_IDLE_TIMEOUT", str(15 * 60)))  # 秒，默认15分钟
MAX_MSG = 64 * 1024 * 1024  # 单条消息上限 64MB，防御异常长度

_last_activity = time.time()
_activity_lock = threading.Lock()


def _touch():
    global _last_activity
    with _activity_lock:
        _last_activity = time.time()


def _idle_seconds():
    with _activity_lock:
        return time.time() - _last_activity


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_msg(conn):
    head = recv_exact(conn, 4)
    if head is None:
        return None
    (length,) = struct.unpack(">I", head)
    if length <= 0 or length > MAX_MSG:
        return None
    body = recv_exact(conn, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def write_msg(conn, obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    conn.sendall(struct.pack(">I", len(data)) + data)


def handle(conn, stop_event):
    try:
        msg = read_msg(conn)
        if msg is None:
            return
        _touch()
        cmd = msg.get("cmd", "embed")
        if cmd == "ping":
            write_msg(conn, {"ok": True, "model": embedder.get_model_name(), "ready": True})
        elif cmd == "info":
            dim = int(embedder.embed(["x"]).shape[1])
            write_msg(conn, {"ok": True, "model": embedder.get_model_name(),
                             "dim": dim, "pid": os.getpid()})
        elif cmd == "shutdown":
            write_msg(conn, {"ok": True, "bye": True})
            stop_event.set()
        elif cmd == "embed":
            texts = msg.get("texts", [])
            is_query = bool(msg.get("is_query", False))
            if isinstance(texts, str):
                texts = [texts]
            vecs = embedder.embed(texts, is_query=is_query)
            write_msg(conn, {
                "ok": True,
                "model": embedder.get_model_name(),
                "dim": int(vecs.shape[1]) if vecs.size else 0,
                "vectors": vecs.tolist(),
            })
        else:
            write_msg(conn, {"ok": False, "error": f"未知 cmd: {cmd}"})
    except Exception as e:  # noqa: BLE001
        try:
            write_msg(conn, {"ok": False, "error": str(e)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def idle_watch(stop_event):
    while not stop_event.is_set():
        if _idle_seconds() > IDLE_TIMEOUT:
            print(f"[embed_daemon] 空闲 {IDLE_TIMEOUT}s，退出释放内存", file=sys.stderr)
            stop_event.set()
            # 戳一下自己，让 accept() 解除阻塞
            try:
                with socket.create_connection((HOST, PORT), timeout=2) as s:
                    s.sendall(struct.pack(">I", 0))  # 0 长度，handle 会忽略
            except Exception:  # noqa: BLE001
                pass
            return
        time.sleep(5)


def main():
    # 强制 UTF-8（日志里可能有中文/特殊字符）
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((HOST, PORT))
    except OSError as e:
        # 端口已被占用 = 多半已有守护进程在跑，直接退出（幂等）
        print(f"[embed_daemon] 端口 {PORT} 绑定失败（可能已有守护进程）: {e}", file=sys.stderr)
        sys.exit(0)
    srv.listen(16)
    srv.settimeout(1.0)

    # 启动即加载模型（把 12s 冷启动开销在守护进程内一次性付清）
    t0 = time.time()
    embedder.load_model()
    print(f"[embed_daemon] 模型 {embedder.get_model_name()} 已就绪，"
          f"加载 {time.time()-t0:.1f}s，监听 {HOST}:{PORT}，idle_timeout={IDLE_TIMEOUT}s",
          file=sys.stderr)

    stop_event = threading.Event()
    threading.Thread(target=idle_watch, args=(stop_event,), daemon=True).start()

    try:
        while not stop_event.is_set():
            try:
                conn, _addr = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            handle(conn, stop_event)
    finally:
        try:
            srv.close()
        except Exception:  # noqa: BLE001
            pass
    print("[embed_daemon] 已退出", file=sys.stderr)


if __name__ == "__main__":
    main()
