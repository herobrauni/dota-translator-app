#!/usr/bin/env python3
import sys
import os
import time
import json
import subprocess

def parse_args():
    process_name = 'dota2'
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '-ProcessName' and i + 1 < len(sys.argv):
            process_name = sys.argv[i + 1]
            i += 2
        else:
            i += 1
    return process_name

def get_env():
    env = os.environ.copy()
    disp = env.get('DISPLAY')
    if not disp and os.path.exists('/tmp/.X11-unix/X1'):
        env['DISPLAY'] = ':1'
    elif not disp and os.path.exists('/tmp/.X11-unix/X0'):
        env['DISPLAY'] = ':0'
    return env

def is_game_in_front(process_name):
    pname = process_name.lower()
    # 1. niri
    if os.environ.get('DESKTOP_SESSION') == 'niri' or os.environ.get('XDG_SESSION_TYPE') == 'wayland':
        try:
            out = subprocess.check_output(['niri', 'msg', '-j', 'focused-window'], stderr=subprocess.DEVNULL)
            d = json.loads(out)
            app = (d.get('app_id') or '').lower()
            title = (d.get('title') or '').lower()
            if pname in app or pname in title or 'dota' in app or 'dota' in title:
                return True
            return False
        except Exception:
            pass

    # 2. xdotool
    try:
        env = get_env()
        w_id = subprocess.check_output(['xdotool', 'getactivewindow'], stderr=subprocess.DEVNULL, env=env).decode().strip()
        cls = subprocess.check_output(['xdotool', 'getwindowclassname', w_id], stderr=subprocess.DEVNULL, env=env).decode().lower().strip()
        name = subprocess.check_output(['xdotool', 'getwindowname', w_id], stderr=subprocess.DEVNULL, env=env).decode().lower().strip()
        if pname in cls or pname in name or 'dota' in cls or 'dota' in name:
            return True
        return False
    except Exception:
        pass

    return False

def run_xdotool(args):
    env = get_env()
    subprocess.run(['xdotool'] + args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

def main():
    process_name = parse_args()
    print('ready', flush=True)

    valid_words = {'copy', 'send', 'clear', 'open team', 'open all', 'paste', 'enter'}

    for line in sys.stdin:
        word = line.strip()
        if not word:
            continue
        if word not in valid_words:
            print('NOT DONE: not a command', flush=True)
            continue

        try:
            if not is_game_in_front(process_name):
                print('NOT DONE: the game is not in front', flush=True)
                continue

            if word == 'open team' or word == 'open all' or word == 'paste' or word == 'enter':
                if not is_game_in_front(process_name):
                    print('NOT DONE: the game is not in front', flush=True)
                    continue

                if word == 'open team':
                    run_xdotool(['key', '--clearmodifiers', 'Return'])
                elif word == 'open all':
                    run_xdotool(['key', '--clearmodifiers', 'shift+Return'])
                elif word == 'paste':
                    run_xdotool(['key', '--clearmodifiers', 'ctrl+a'])
                    time.sleep(0.04)
                    run_xdotool(['key', '--clearmodifiers', 'ctrl+v'])
                else: # enter
                    run_xdotool(['key', '--clearmodifiers', 'Return'])

                time.sleep(0.09)
                print('done', flush=True)
                continue

            if word == 'clear':
                run_xdotool(['key', '--clearmodifiers', 'ctrl+a'])
                time.sleep(0.04)
                run_xdotool(['key', '--clearmodifiers', 'BackSpace'])
                time.sleep(0.04)
                run_xdotool(['key', '--clearmodifiers', 'Escape'])
                time.sleep(0.06)
                print('done', flush=True)
                continue

            if word == 'copy':
                run_xdotool(['key', '--clearmodifiers', 'ctrl+a'])
                time.sleep(0.06)
                run_xdotool(['key', '--clearmodifiers', 'ctrl+c'])
                time.sleep(0.08)
                print('copied', flush=True)
                continue

            if word == 'send':
                run_xdotool(['key', '--clearmodifiers', 'ctrl+a'])
                time.sleep(0.06)
                run_xdotool(['key', '--clearmodifiers', 'ctrl+v'])
                time.sleep(0.12)
                if not is_game_in_front(process_name):
                    print('NOT DONE: the game lost focus', flush=True)
                    continue
                run_xdotool(['key', '--clearmodifiers', 'Return'])
                print('sent', flush=True)
                continue

        except Exception:
            print('NOT DONE: the helper failed', flush=True)

if __name__ == '__main__':
    main()
