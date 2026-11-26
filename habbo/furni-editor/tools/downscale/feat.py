# Features and labels for learning which pixel of a 2x2 block Sulake's artists kept.
import numpy as np, zlib
from lab import *

WIN = 6           # the 2x2 block and two pixels around it
NCLASS = 5        # tl, tr, bl, br, transparent

def windows(Lp):
    """(h, w, 6, 6, 4) float windows for every block of an even-sized RGBA picture."""
    H, W = Lp.shape[:2]
    big = np.zeros((H + 4, W + 4, 4), np.float32); big[..., :3] = 255
    big[2:2 + H, 2:2 + W] = Lp
    h, w = H // 2, W // 2
    out = np.empty((h, w, WIN, WIN, 4), np.float32)
    for yy in range(WIN):
        for xx in range(WIN):
            out[:, :, yy, xx] = big[yy: yy + 2 * h: 2, xx: xx + 2 * w: 2]
    return out

CAND = [(2, 2), (2, 3), (3, 2), (3, 3)]

def features(win):
    """win: (n, 6, 6, 4) -> (n, F) features that don't depend on where the picture is."""
    n = win.shape[0]
    a = (win[..., 3] >= 128).astype(np.float32)                     # (n,6,6)
    rgb = win[..., :3] / 255.0 * a[..., None]                        # transparent pixels are black with a = 0
    l = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])
    f = [a.reshape(n, -1), l.reshape(n, -1), rgb.reshape(n, -1)]
    cand = np.stack([win[:, y, x] for (y, x) in CAND], 1)           # (n,4,4)
    ca = (cand[..., 3] >= 128).astype(np.float32)
    crgb = cand[..., :3] / 255.0 * ca[..., None]
    # how alike the candidates are, pair by pair
    for i in range(4):
        for j in range(i + 1, 4):
            d = np.sqrt(((crgb[:, i] - crgb[:, j]) ** 2).sum(-1)) / 1.732
            same = ((d < 1e-4) & (ca[:, i] == ca[:, j])).astype(np.float32)
            f += [d[:, None], same[:, None]]
    # how common each candidate's colour is around it (the whole window, and the 4x4 middle)
    flat = rgb.reshape(n, 36, 3); fa = a.reshape(n, 36)
    inner = np.zeros((6, 6), bool); inner[1:5, 1:5] = True; inner = inner.reshape(36)
    for i in range(4):
        d = np.abs(flat - crgb[:, None, i]).sum(-1)
        eq = ((d < 1e-4) & (fa == ca[:, None, i])).astype(np.float32)
        near = ((d < 0.12) & (fa == ca[:, None, i])).astype(np.float32)
        f += [eq.mean(1, keepdims=True), eq[:, inner].mean(1, keepdims=True), near.mean(1, keepdims=True)]
    # how much of the window is see-through, and on which sides
    f += [a.mean((1, 2))[:, None], a[:, :2].mean((1, 2))[:, None], a[:, 4:].mean((1, 2))[:, None], a[:, :, :2].mean((1, 2))[:, None], a[:, :, 4:].mean((1, 2))[:, None]]
    return np.concatenate(f, 1).astype(np.float32)

def canonical(win, label):
    """Of candidates with the same colour, the first one: the label a picture and its mirror image agree on."""
    cand = np.stack([win[:, y, x] for (y, x) in CAND], 1)
    label = label.copy()
    for i in range(3, 0, -1):
        for j in range(i):
            same = np.abs(cand[:, i] - cand[:, j]).sum(-1) < 0.5
            label = np.where((label == i) & same, j, label)
    return label

def flip_windows(win):
    return win[:, :, ::-1]

FLIP_LABEL = np.array([1, 0, 3, 2, 4])

def align(p):
    """The block phase and shift under which Sulake's picture is closest to a pick from the 2x2 blocks."""
    S, sreg = p['S'], p['sreg']
    best = None
    for oy in (0, 1):
        for ox in (0, 1):
            Lp = pad_even(p['L'], ox, oy)
            win = windows(Lp)
            h, w = win.shape[:2]
            creg = creg_of(p['reg'], ox, oy)
            cand = np.stack([win[:, :, y, x] for (y, x) in CAND], 2)   # (h,w,4,4)
            cop = cand[..., 3] >= 128
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    # S on the candidate's grid
                    Sg = np.zeros((h, w, 4), np.float32)
                    left, top = (creg[0] + dx) - sreg[0], (creg[1] + dy) - sreg[1]
                    ys0, xs0 = max(0, -top), max(0, -left)
                    yd0, xd0 = max(0, top), max(0, left)
                    hh = min(S.shape[0] - ys0, h - yd0); ww = min(S.shape[1] - xs0, w - xd0)
                    if hh <= 0 or ww <= 0: continue
                    Sg[yd0:yd0 + hh, xd0:xd0 + ww] = S[ys0:ys0 + hh, xs0:xs0 + ww]
                    lost = (S[..., 3] >= 128).sum() - (Sg[..., 3] >= 128).sum()
                    sop = Sg[..., 3] >= 128
                    d = np.sqrt(((cand[..., :3] - Sg[:, :, None, :3]) ** 2).sum(-1)) / 441.7
                    d = np.where(cop, d, 9.0)
                    dmin = d.min(2); arg = d.argmin(2)
                    anyop = cop.any(2)
                    # of the pixels either picture has: the ones Sulake's pixel is one of the block's four
                    exact = (sop & anyop & (dmin < 0.02)).sum()
                    total = (sop | anyop).sum() + lost
                    if total == 0: continue
                    q = exact / total
                    if best is None or q > best[0]:
                        best = (q, ox, oy, dx, dy, win, Sg, dmin, arg, sop, anyop)
    return best

def samples(p, min_quality=0.3):
    b = align(p)
    if b is None or b[0] < min_quality: return None
    q, ox, oy, dx, dy, win, Sg, dmin, arg, sop, anyop = b
    keep = (anyop) & ~(sop & (dmin > 8))          # blocks with something in them
    label = np.where(sop, arg, 4)
    # the first of candidates that are the same colour
    cand = np.stack([win[:, :, y, x] for (y, x) in CAND], 2)
    for i in range(3, 0, -1):
        for j in range(i):
            same = (np.abs(cand[:, :, i] - cand[:, :, j]).sum(-1) < 0.5)
            label = np.where((label == i) & same, j, label)
    weight = np.where(sop, np.where(dmin < 0.02, 1.0, 0.25), 1.0)
    w = win[keep]; y = label[keep]; wt = weight[keep]
    return w, y.astype(np.int64), wt.astype(np.float32), q

def is_test(cls):
    return zlib.crc32(cls.encode()) % 5 == 0

if __name__ == '__main__':
    pairs = load_pairs()
    tr, te = [], []
    used = 0; qs = []
    for p in pairs:
        s = samples(p)
        if s is None: continue
        used += 1; qs.append(s[3])
        (te if is_test(p['cls']) else tr).append(s)
    print('pairs used', used, 'of', len(pairs), 'mean agreement', np.mean(qs))
    def pack(lst, augment):
        W = np.concatenate([s[0] for s in lst]); Y = np.concatenate([s[1] for s in lst]); T = np.concatenate([s[2] for s in lst])
        if augment:
            W = np.concatenate([W, flip_windows(W)]); Y = np.concatenate([Y, FLIP_LABEL[Y]]); T = np.concatenate([T, T])
        X = np.concatenate([features(W[i:i + 200000]) for i in range(0, len(W), 200000)])
        return X, canonical(W, Y), T
    Xtr, Ytr, Ttr = pack(tr, True); Xte, Yte, Tte = pack(te, False)
    print('train', Xtr.shape, 'test', Xte.shape, 'classes', np.bincount(Ytr, minlength=5) / len(Ytr))
    np.savez_compressed('train.npz', Xtr=Xtr, Ytr=Ytr, Ttr=Ttr, Xte=Xte, Yte=Yte, Tte=Tte)
