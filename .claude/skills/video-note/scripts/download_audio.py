#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载视频直链的音频，输出 16kHz 单声道 wav 供 ASR。

用法:
    python download_audio.py --url <直链> --out <wav路径> [--referer <防盗链>]

直链通常是 mp4（含音视频），用 ffmpeg 提音频、转 16k 单声道 pcm wav。
带 Referer 头处理防盗链（抖音/B站直链需要）。
ffmpeg 自动查找：PATH → WinGet Links → WinGet Packages（兼容 winget 装完未刷新 PATH）。
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path
from shutil import which


def find_ffmpeg() -> str:
    # 1. PATH
    p = which('ffmpeg')
    if p:
        return p
    local = os.environ.get('LOCALAPPDATA', '')
    # 2. WinGet Links（shim）
    link = os.path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')
    if os.path.isfile(link):
        return link
    # 3. WinGet Packages glob（真实包）
    pkg = os.path.join(local, 'Microsoft', 'WinGet', 'Packages')
    if os.path.isdir(pkg):
        for root, _dirs, files in os.walk(pkg):
            if 'ffmpeg.exe' in files:
                return os.path.join(root, 'ffmpeg.exe')
    return 'ffmpeg'  # 兜底，让系统报错


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--url', required=True, help='视频直链（play_addr url_list 里的）')
    ap.add_argument('--out', required=True, help='输出 wav 路径')
    ap.add_argument('--referer', default='https://www.douyin.com/', help='防盗链 Referer')
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    ff = find_ffmpeg()
    # ffmpeg 提音频：去视频、单声道、16kHz、pcm_s16le（ASR 标准输入）
    cmd = [
        ff, '-y',
        '-headers', f'Referer: {args.referer}\r\nUser-Agent: Mozilla/5.0\r\n',
        '-i', args.url,
        '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
        str(out),
    ]
    print(f'[download] ffmpeg={ff}', flush=True)
    print(f'[download] {args.url[:90]} -> {out}', flush=True)
    # errors='replace' 防 ffmpeg 中文 stderr(GBK) 解码崩溃
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-2000:] + '\n')
        print('[download] FAILED', file=sys.stderr)
        return 1
    print(f'[download] OK {out} ({out.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
