# video-note 安装（新机器 / 开源版复现）

此文档供新环境复现。所有命令在仓库根下跑——用 `git rev-parse --show-toplevel` 取本机实际根路径；下文命令多用相对路径（`.venv-video-note/`、`models/`、`.claude/...`），确保当前工作目录是仓库根即可。

## 1. Python 3.12 专用 venv（避开系统 Python 版本坑）
系统若已是 Python 3.12+ 且 funasr 兼容，可跳过；否则用 uv 建独立 venv：
```bash
uv venv --python 3.12 ".venv-video-note"
```

## 2. torch CUDA + funasr
```bash
VPY=".venv-video-note/Scripts/python.exe"
# torch CUDA 版（cu128 兼容 CUDA 13.x driver，向下兼容）
uv pip install --python "$VPY" torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$VPY" funasr
```
验证：`$VPY -c "import torch; print(torch.__version__, torch.cuda.is_available())"` → 应 `True`

## 3. ffmpeg
```bash
winget install Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
```
（download_audio.py 自动从 WinGet Links/Packages 找 ffmpeg，PATH 没刷新也能用）

## 4. SenseVoice 模型（从 hf-mirror，63MB/s 极快）
> ⚠️ huggingface_hub 在国内 head 检查会失败，**用 curl 手动下**，别用 snapshot_download。
```bash
mkdir -p models/SenseVoiceSmall
BASE="https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall/resolve/main"
for f in config.yaml am.mvn tokens.json configuration.json chn_jpn_yue_eng_ko_spectok.bpe.model model.pt; do
  curl -sL "$BASE/$f" -o "models/SenseVoiceSmall/$f"
done
```
（model.pt 893MB，约 15 秒下完）

## 5. VAD 模型（从 modelscope，1.7MB 小）
```bash
mkdir -p models/speech_fsmn_vad
MBASE="https://modelscope.cn/api/v1/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch/repo?Revision=master&FilePath"
for f in config.yaml am.mvn configuration.json model.pt; do
  curl -sL "${MBASE}=${f}" -o "models/speech_fsmn_vad/$f"
done
```

## 6. 中文路径（自动处理）
仓库路径含中文时，funasr/sentencepiece/torchaudio 的 C 扩展会崩（GBK）。
transcribe.py 检测到非 ASCII 路径会自动 `subst` 一个盘符（V:/W:/...）映射仓库根，对调用方透明，**无需手动处理**。

## 7. .gitignore
已加（防 GB 级依赖/模型入库）：
```
.venv-video-note/   .venv*/   models/   __pycache__/   *.pyc
```

## 验证端到端
```bash
VPY=".venv-video-note/Scripts/python.exe"
# 抖音/B站链接需先 chrome-devtools 取流拿直链（见 references/）
$VPY .claude/skills/video-note/scripts/transcribe.py --audio <某.wav> --out <某.txt>
# 应秒级输出转写文本（GPU rtf~0.006）
```
