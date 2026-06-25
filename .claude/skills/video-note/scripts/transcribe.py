#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SenseVoice 转写音频为文字。默认 GPU(cuda), 带 VAD 分段(长音频)。

与 CapsWriter 的 qwen_asr 不抢资源: CapsWriter 走 Vulkan(llama.cpp/GGUF),
本脚本走 CUDA(PyTorch/funasr), 两套独立 GPU 后端, 各占各显存。两者极少同时
运行, RTX 3060 12G 显存够(qwen~1.6G + SenseVoice~1G), 直接用 GPU 不刻意错开。

中文路径处理(关键): funasr/sentencepiece/torchaudio 的 C 扩展在 Windows 中文
路径下会崩(GBK 编码 "No such file")。本脚本检测仓库根是否含非 ASCII, 若是
自动 subst 一个盘符(V:) 映射到仓库根, 把传给 funasr 的路径转成 ASCII 盘符路径,
对调用者完全透明(调用方照常用仓库内中文路径)。

用法:
    python transcribe.py --audio <wav> --out <txt> [--device cuda] [--no-vad]

模型: 默认 <仓库>/models/SenseVoiceSmall + <仓库>/models/speech_fsmn_vad。
首次需手动下载(见 SKILL.md 安装步骤)。
依赖: funasr + torch(CUDA 版), 装在专用 venv .venv-video-note。
输入: 16kHz 单声道 wav(download_audio.py 产出)。
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# scripts -> video-note -> skills -> .claude -> 仓库根
REPO = Path(__file__).resolve().parents[4]


def _is_ascii(s: str) -> bool:
    try:
        str(s).encode('ascii')
        return True
    except UnicodeEncodeError:
        return False


def ensure_ascii_drive():
    """仓库根含中文时, subst 一个盘符(优先 V:) 到仓库根, 返回盘符 'V:'。
    仓库已 ASCII 或 subst 失败返回 None。"""
    if _is_ascii(str(REPO)):
        return None
    for letter in 'VWXYZU':
        if not os.path.exists(letter + ':\\') and not os.path.exists(letter + ':'):
            drive = letter + ':'
            subprocess.run(['cmd', '/c', 'subst', drive, str(REPO)], capture_output=True)
            if os.path.isdir(drive + '\\'):
                return drive
            break
    return None


def to_ascii(p, drive):
    """仓库内路径转 ASCII 盘符路径(drive 有值时); 否则原样正斜杠化。"""
    if drive is None:
        return str(p).replace('\\', '/')
    try:
        rel = Path(p).resolve().relative_to(REPO.resolve())
        return (drive + '/' + str(rel)).replace('\\', '/')
    except ValueError:
        return str(p).replace('\\', '/')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--audio', required=True, help='输入音频(16k mono wav)')
    ap.add_argument('--out', required=True, help='输出 txt 路径')
    ap.add_argument('--device', default='cuda', help='cuda(GPU,默认)/cpu')
    ap.add_argument('--model', default=str(REPO / 'models' / 'SenseVoiceSmall'), help='SenseVoice 模型目录')
    ap.add_argument('--vad', default=str(REPO / 'models' / 'speech_fsmn_vad'), help='VAD 模型目录')
    ap.add_argument('--no-vad', action='store_true', help='禁用 VAD(短视频可选)')
    args = ap.parse_args()

    audio = Path(args.audio)
    if not audio.is_file():
        print(f'[asr] 音频不存在: {audio}', file=sys.stderr)
        return 1
    model_dir = Path(args.model)
    if not (model_dir / 'model.pt').is_file():
        print(f'[asr] SenseVoice 模型不存在: {model_dir}/model.pt', file=sys.stderr)
        return 1

    try:
        from funasr import AutoModel
    except ImportError:
        print('[asr] 未装 funasr, 请在 .venv-video-note 里 pip install funasr torch', file=sys.stderr)
        return 2

    device = args.device
    if device == 'cuda':
        try:
            import torch
            if not torch.cuda.is_available():
                print('[asr] torch.cuda 不可用, 降级 cpu', file=sys.stderr)
                device = 'cpu'
        except ImportError:
            device = 'cpu'

    # 中文路径 -> ASCII 盘符(funasr/sentencepiece/torchaudio 的 C 扩展要求)
    drive = ensure_ascii_drive()
    model_p = to_ascii(Path(args.model), drive)
    audio_p = to_ascii(audio, drive)

    use_vad = bool(args.vad) and not args.no_vad and (Path(args.vad) / 'model.pt').is_file()
    vad_p = to_ascii(Path(args.vad), drive) if use_vad else None

    print(f'[asr] 加载 model={model_p} vad={vad_p} (device={device})...', flush=True)
    if vad_p:
        model = AutoModel(
            model=model_p, vad_model=vad_p,
            vad_kwargs={'max_single_segment_time': 30000},
            device=device, disable_update=True,
        )
    else:
        model = AutoModel(model=model_p, device=device, disable_update=True)
    print('[asr] 转写中...', flush=True)
    res = model.generate(input=audio_p, language='zh', use_itn=True, batch_size_s=300)
    text = ''.join(r.get('text', '') for r in res).strip()
    # SenseVoice 输出带 <|zh|><|NEUTRAL|><|Speech|><|woitn|> 等标签前缀, 清掉
    text = re.sub(r'<\|[^|]+\|>', '', text).strip()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding='utf-8')
    print(f'[asr] OK {out} ({len(text)} 字)')
    print('---转写预览(前400字)---')
    print(text[:400])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
