#!/usr/bin/env python3
import sys
import os
import time
import json
import subprocess

def parse_args():
    parent_pid = 0
    interval_ms = 250
    process_name = 'dota2'
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '-ParentPid' and i + 1 < len(sys.argv):
            try: parent_pid = int(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        elif arg == '-IntervalMs' and i + 1 < len(sys.argv):
            try: interval_ms = int(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        elif arg == '-ProcessName' and i + 1 < len(sys.argv):
            process_name = sys.argv[i + 1]
            i += 2
        else:
            i += 1
    return parent_pid, interval_ms, process_name

def check_parent_alive(pid):
    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def get_front_window(process_name):
    pname = process_name.lower()

    # 1. Try niri (Wayland compositor)
    if os.environ.get('DESKTOP_SESSION') == 'niri' or os.environ.get('XDG_SESSION_TYPE') == 'wayland':
        try:
            out = subprocess.check_output(['niri', 'msg', '-j', 'focused-window'], stderr=subprocess.DEVNULL)
            d = json.loads(out)
            app = (d.get('app_id') or '').lower()
            title = (d.get('title') or '').lower()
            if pname in app or pname in title or 'dota' in app or 'dota' in title:
                ws = d.get('layout', {}).get('window_size', [1920, 1080])
                gx, gy = 0, 0
                try:
                    f_out = subprocess.check_output(['niri', 'msg', '-j', 'focused-output'], stderr=subprocess.DEVNULL)
                    log = json.loads(f_out).get('logical', {})
                    gx = int(log.get('x', 0))
                    gy = int(log.get('y', 0))
                except Exception:
                    pass
                return True, gx, gy, int(ws[0]), int(ws[1])
            return False, 0, 0, 0, 0
        except Exception:
            pass

    # 2. Try Hyprland
    if os.environ.get('HYPRLAND_INSTANCE_SIGNATURE'):
        try:
            out = subprocess.check_output(['hyprctl', 'activewindow', '-j'], stderr=subprocess.DEVNULL)
            d = json.loads(out)
            cls = (d.get('class') or '').lower()
            title = (d.get('title') or '').lower()
            if pname in cls or pname in title or 'dota' in cls or 'dota' in title:
                at = d.get('at', [0, 0])
                size = d.get('size', [1920, 1080])
                return True, int(at[0]), int(at[1]), int(size[0]), int(size[1])
            return False, 0, 0, 0, 0
        except Exception:
            pass

    # 3. Try Sway
    if os.environ.get('SWAYSOCK'):
        try:
            out = subprocess.check_output(['swaymsg', '-t', 'get_tree'], stderr=subprocess.DEVNULL)
            # Find focused node in sway tree
            def find_focused(node):
                if node.get('focused'):
                    return node
                for c in node.get('nodes', []) + node.get('floating_nodes', []):
                    r = find_focused(c)
                    if r: return r
                return None
            tree = json.loads(out)
            f = find_focused(tree)
            if f:
                app = (f.get('app_id') or '').lower()
                name = (f.get('name') or '').lower()
                if pname in app or pname in name or 'dota' in app or 'dota' in name:
                    r = f.get('rect', {})
                    return True, int(r.get('x', 0)), int(r.get('y', 0)), int(r.get('width', 1920)), int(r.get('height', 1080))
            return False, 0, 0, 0, 0
        except Exception:
            pass

    # 4. Standard X11 / Xwayland via xdotool
    try:
        disp = os.environ.get('DISPLAY')
        env = os.environ.copy()
        if not disp and os.path.exists('/tmp/.X11-unix/X1'):
            env['DISPLAY'] = ':1'
        elif not disp and os.path.exists('/tmp/.X11-unix/X0'):
            env['DISPLAY'] = ':0'
        
        w_id = subprocess.check_output(['xdotool', 'getactivewindow'], stderr=subprocess.DEVNULL, env=env).decode().strip()
        cls = subprocess.check_output(['xdotool', 'getwindowclassname', w_id], stderr=subprocess.DEVNULL, env=env).decode().lower().strip()
        name = subprocess.check_output(['xdotool', 'getwindowname', w_id], stderr=subprocess.DEVNULL, env=env).decode().lower().strip()
        if pname in cls or pname in name or 'dota' in cls or 'dota' in name:
            geom = subprocess.check_output(['xdotool', 'getwindowgeometry', w_id], stderr=subprocess.DEVNULL, env=env).decode()
            pos = [l for l in geom.splitlines() if 'Position:' in l][0].split('Position:')[1].split()[0].split(',')
            size = [l for l in geom.splitlines() if 'Geometry:' in l][0].split('Geometry:')[1].strip().split('x')
            return True, int(pos[0]), int(pos[1]), int(size[0]), int(size[1])
        return False, 0, 0, 0, 0
    except Exception:
        pass

    return False, 0, 0, 0, 0

def main():
    parent_pid, interval_ms, process_name = parse_args()
    sleep_sec = max(0.05, interval_ms / 1000.0)

    last_client = ''
    client_at = 0.0
    on = -1

    while True:
        if not check_parent_alive(parent_pid):
            sys.exit(0)

        is_front, x, y, w, h = get_front_window(process_name)
        now_on = 1 if is_front else 0

        if now_on != on:
            on = now_on
            print(f'{{"t":"focus","on":{on}}}', flush=True)

        if on == 1:
            c = f'{x},{y},{w},{h}'
            now = time.time()
            due = (now - client_at) >= 5.0
            if c != last_client or due:
                last_client = c
                client_at = now
                print(f'{{"t":"window","x":{x},"y":{y},"w":{w},"h":{h}}}', flush=True)
        else:
            last_client = ''

        time.sleep(sleep_sec)

if __name__ == '__main__':
    main()
