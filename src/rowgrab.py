#!/usr/bin/env python3
import sys
import os
import time
import math
import json
import re
import subprocess
from PIL import Image

try:
    import numpy as np
    HAVE_NUMPY = True
except ImportError:
    HAVE_NUMPY = False

W, H = 16, 9
TOP = 0.6

names = []
known = []
knownTop = []

def parse_args():
    parent_pid = 0
    refs = ''
    process_name = 'dota2'
    slack = 8
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '-ParentPid' and i + 1 < len(sys.argv):
            try: parent_pid = int(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        elif arg == '-Refs' and i + 1 < len(sys.argv):
            refs = sys.argv[i + 1]
            i += 2
        elif arg == '-ProcessName' and i + 1 < len(sys.argv):
            process_name = sys.argv[i + 1]
            i += 2
        elif arg == '-Slack' and i + 1 < len(sys.argv):
            try: slack = int(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        else:
            i += 1
    return parent_pid, refs, process_name, slack

def check_parent_alive(pid):
    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def make_thumb(im, x, y, w, h):
    crop = im.crop((int(x), int(y), int(x + w), int(y + h)))
    resized = crop.resize((W, H), Image.Resampling.BILINEAR).convert('RGB')
    raw = resized.tobytes()
    v = [float(b) for b in raw]
    mean = sum(v) / len(v)
    v = [val - mean for val in v]
    norm = math.sqrt(sum(val * val for val in v))
    if norm > 0:
        v = [val / norm for val in v]
    return v

def add_ref(name, file_path):
    with Image.open(file_path) as r:
        names.append(name)
        known.append(make_thumb(r, 0, 0, r.width, r.height))
        knownTop.append(make_thumb(r, 0, 0, r.width, r.height * TOP))

def get_env():
    env = os.environ.copy()
    disp = env.get('DISPLAY')
    if not disp and os.path.exists('/tmp/.X11-unix/X1'):
        env['DISPLAY'] = ':1'
    elif not disp and os.path.exists('/tmp/.X11-unix/X0'):
        env['DISPLAY'] = ':0'
    return env

def get_front_window(process_name):
    pname = process_name.lower()
    # 1. niri
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

    # 2. xdotool
    try:
        env = get_env()
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

def get_dota_window_id():
    env = get_env()
    try:
        out = subprocess.check_output(['xdotool', 'search', '--class', 'dota2'], env=env, stderr=subprocess.DEVNULL).decode().strip()
        lines = [l for l in out.splitlines() if l.strip().isdigit()]
        if lines:
            return lines[0]
    except Exception:
        pass
    try:
        w_id = subprocess.check_output(['xdotool', 'getactivewindow'], env=env, stderr=subprocess.DEVNULL).decode().strip()
        if w_id.isdigit():
            return w_id
    except Exception:
        pass
    return None

def capture_rect(x, y, w, h):
    env = get_env()
    win_id = get_dota_window_id()
    if not win_id:
        return None

    import tempfile
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tf:
        tmp_name = tf.name

    try:
        cmd = ['import', '-window', win_id, '-crop', f'{int(w)}x{int(h)}+{int(x)}+{int(y)}', tmp_name]
        subprocess.run(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        with Image.open(tmp_name) as im:
            return im.copy()
    except Exception:
        return None
    finally:
        try:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
        except OSError:
            pass

def best_match(bmp, ox, oy, tw, th, slack, ref_list):
    if not names or not ref_list:
        return '"ok":0,"why":"no reference portraits"'

    best = [-2.0] * len(names)

    # Collect thumbnail vectors for all offsets
    thumbs = []
    dxs = list(range(-slack, slack + 1, 2))
    dys = list(range(-slack, slack + 1, 2))

    for dx in dxs:
        for dy in dys:
            if ox + dx < 0 or oy + dy < 0 or ox + dx + tw > bmp.width or oy + dy + th > bmp.height:
                continue
            t = make_thumb(bmp, ox + dx, oy + dy, tw, th)
            thumbs.append(t)

    if not thumbs:
        return '"ok":0,"why":"outside bounds"'

    if HAVE_NUMPY:
        T = np.array(thumbs, dtype=np.float32)
        K = np.array(ref_list, dtype=np.float32)
        scores = np.dot(T, K.T)
        best_scores = np.max(scores, axis=0)
        sorted_indices = np.argsort(best_scores)[::-1]
        a = sorted_indices[0]
        b = sorted_indices[1] if len(sorted_indices) > 1 else -1
        best_a = float(best_scores[a])
        best_b = float(best_scores[b]) if b >= 0 else -2.0
    else:
        for t in thumbs:
            for k, r in enumerate(ref_list):
                d = sum(t[i] * r[i] for i in range(len(t)))
                if d > best[k]:
                    best[k] = d
        a = -1
        b = -1
        for k in range(len(best)):
            if a < 0 or best[k] > best[a]:
                b = a
                a = k
            elif b < 0 or best[k] > best[b]:
                b = k
        best_a = best[a]
        best_b = best[b] if b >= 0 else -2.0

    res = f'"ok":1,"hero":"{names[a]}","score":{best_a:.3f}'
    if b >= 0:
        res += f',"second":"{names[b]}","score2":{best_b:.3f}'
    return res

def chan_runs(bmp, s):
    w, h = bmp.size
    rgb = bmp.convert('RGB')
    res = []
    start = -1
    for x in range(w + 1):
        lit = False
        if x < w:
            for y in range(h):
                r, g, b = rgb.getpixel((x, y))
                if max(r, g, b) > 200:
                    lit = True
                    break
        if lit and start < 0:
            start = x
        if not lit and start >= 0:
            if len(res) < 60:
                res.append([start, x - 1])
            start = -1
    return f'"ok":1,"s":{s:.4f},"runs":{json.dumps(res)}'

def main():
    parent_pid, refs, process_name, slack = parse_args()

    count = 0
    if refs and os.path.isdir(refs):
        for f in sorted(os.listdir(refs)):
            base, ext = os.path.splitext(f)
            if re.match(r'^[a-z_]+$', base) and ext.lower() in ('.bmp', '.png'):
                try:
                    add_ref(base, os.path.join(refs, f))
                    count += 1
                except Exception:
                    pass

    print(f'{{"t":"ready","refs":{count}}}', flush=True)

    for line in sys.stdin:
        if not check_parent_alive(parent_pid):
            sys.exit(0)

        p = line.strip().split(' ', 6)
        if len(p) < 2 or not p[1].isdigit():
            continue

        cmd = p[0]
        req_id = p[1]
        answer = ''

        if (cmd == 'file' or cmd == 'topfile') and len(p) == 7:
            try:
                ox = float(p[2])
                oy = float(p[3])
                tw = float(p[4])
                th = float(p[5])
                file_path = p[6]
                with Image.open(file_path) as bmp:
                    s_slack = 6 if cmd == 'topfile' else slack
                    ref_list = knownTop if cmd == 'topfile' else known
                    answer = best_match(bmp, ox, oy, tw, th, s_slack, ref_list)
            except Exception:
                answer = '"ok":0,"why":"could not read the picture"'
        elif cmd not in ('row', 'chan', 'seat'):
            continue
        elif cmd == 'seat' and (len(p) != 3 or not p[2].isdigit()):
            continue
        else:
            try:
                is_front, _, _, _, _ = get_front_window(process_name)
                if not is_front:
                    answer = '"ok":0,"why":"the game is not in front"'
                else:
                    win_id = get_dota_window_id()
                    env = get_env()
                    gw, gh = 1920, 1080
                    if win_id:
                        try:
                            geom = subprocess.check_output(['xdotool', 'getwindowgeometry', win_id], env=env, stderr=subprocess.DEVNULL).decode()
                            m = re.search(r'Geometry:\s*(\d+)x(\d+)', geom)
                            if m:
                                gw, gh = int(m.group(1)), int(m.group(2))
                        except Exception:
                            pass

                    if gh < 400 or gw < 600:
                        answer = '"ok":0,"why":"the game window is too small"'
                    elif cmd == 'chan':
                        s = gh / 1080.0
                        bx = math.floor(gw / 2.0 - 410.0 * s)
                        by = math.floor(760.0 * s)
                        bw = math.ceil(260.0 * s)
                        bh = math.ceil(27.0 * s)
                        bmp = capture_rect(bx, by, bw, bh)
                        if bmp:
                            answer = chan_runs(bmp, s)
                        else:
                            answer = '"ok":0,"why":"capture failed"'
                    elif cmd == 'seat':
                        s = gh / 1080.0
                        seat = int(p[2])
                        off = -416.25 + 62.25 * seat if seat < 5 else 107.25 + 62.25 * (seat - 5)
                        tx = gw / 2.0 + off * s
                        ty = 4.5 * s
                        tw = 60.0 * s
                        th = 34.5 * TOP * s
                        bx = math.floor(tx) - slack
                        by = max(0, math.floor(ty) - slack)
                        bw = math.ceil(tw) + 2 * slack + 2
                        bh = math.ceil(th) + 2 * slack + 2
                        bmp = capture_rect(bx, by, bw, bh)
                        if bmp:
                            answer = best_match(bmp, tx - bx, ty - by, tw, th, 6, knownTop)
                        else:
                            answer = '"ok":0,"why":"capture failed"'
                    else: # row
                        s = gh / 1080.0
                        tx = gw / 2.0 - 362.25 * s
                        ty = 735.75 * s
                        tw = 39.75 * s
                        th = 24.0 * s
                        bx = math.floor(tx) - slack
                        by = math.floor(ty) - slack
                        bw = math.ceil(tw) + 2 * slack + 2
                        bh = math.ceil(th) + 2 * slack + 2
                        bmp = capture_rect(bx, by, bw, bh)
                        if bmp:
                            answer = best_match(bmp, tx - bx, ty - by, tw, th, slack, known)
                        else:
                            answer = '"ok":0,"why":"capture failed"'
            except Exception as e:
                answer = '"ok":0,"why":"grab failed"'

        t_type = 'chan' if cmd == 'chan' else 'row'
        print(f'{{"t":"{t_type}","id":{req_id},{answer}}}', flush=True)

if __name__ == '__main__':
    main()
