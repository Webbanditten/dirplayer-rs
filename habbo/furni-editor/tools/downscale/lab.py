# Loading the picture pairs (pairs.ts), scoring a halved picture against the small picture Sulake drew, the editor's
# earlier halving for comparison, and the network.
import json, os, glob, sys
import numpy as np
from PIL import Image

DATA = os.environ.get('DS32_DATA') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

def load_pairs(limit=None, only=None):
    pairs = []
    for d in sorted(os.listdir(DATA)):
        if only and not only(d): continue
        mp = os.path.join(DATA, d, 'meta.json')
        if not os.path.exists(mp): continue
        for m in json.load(open(mp)):
            L = np.array(Image.open(os.path.join(DATA, d, 'L_%s.png' % m['name'])).convert('RGBA'))
            S = np.array(Image.open(os.path.join(DATA, d, 'S_%s.png' % m['name'])).convert('RGBA'))
            pairs.append(dict(cls=d, name=m['name'], L=L, S=S, reg=m['reg'], sreg=m['sreg'], ink=m['ink'], depth=m['depth']))
        if limit and len(pairs) >= limit: break
    return pairs

def lum(rgb):
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]

def pad_even(L, ox=0, oy=0):
    """L padded so that blocks start at (ox, oy) phase and the size is even."""
    h, w = L.shape[:2]
    top, left = oy, ox
    H = h + top; W = w + left
    H += H % 2; W += W % 2
    out = np.zeros((H, W, 4), np.uint8); out[..., :3] = 255
    out[top:top + h, left:left + w] = L
    return out

def blocks(L):
    """(h/2, w/2, 4, 4): the four pixels of every 2x2 block (order: tl, tr, bl, br)."""
    h, w = L.shape[:2]
    return L.reshape(h // 2, 2, w // 2, 2, 4).transpose(0, 2, 1, 3, 4).reshape(h // 2, w // 2, 4, 4)

# ---------------------------------------------------------------- methods: L (RGBA) -> small RGBA

def current(L, mode=False):
    """The editor's halve(): a dark pixel wins, mostly-background stays background, else the average (or commonest)."""
    B = blocks(pad_even(L)).astype(np.int32)
    seen = B[..., 3] >= 128
    lm = lum(B[..., :3])
    h, w = B.shape[:2]
    out = np.zeros((h, w, 4), np.uint8); out[..., :3] = 255
    for y in range(h):
        for x in range(w):
            s = seen[y, x]
            if not s.any(): continue
            cand = [i for i in range(4) if s[i] and lm[y, x, i] < 64]
            if cand:
                i = min(cand, key=lambda i: lm[y, x, i]); out[y, x] = B[y, x, i]; continue
            if (~s).sum() > s.sum(): continue
            px = B[y, x][s]
            if mode:
                vals, cnt = np.unique(px, axis=0, return_counts=True); out[y, x] = vals[cnt.argmax()]
            else:
                out[y, x] = np.round(px.mean(axis=0))
    return out

# ---------------------------------------------------------------- scoring

def place(img, reg, box):
    """img on a canvas covering box = (x0, y0, x1, y1) in registration-point coordinates."""
    x0, y0, x1, y1 = box
    out = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
    h, w = img.shape[:2]
    left, top = -reg[0] - x0, -reg[1] - y0
    out[top:top + h, left:left + w] = img
    return out

def score(C, creg, S, sreg, search=1):
    """Mean error of candidate C against Sulake's S, both placed by their registration points; the best of small
    shifts counts (a hand-drawn picture may sit a pixel off). 0 = the same, 1 = nothing right."""
    best = None
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            r = (creg[0] + dx, creg[1] + dy)
            x0 = min(-r[0], -sreg[0]); y0 = min(-r[1], -sreg[1])
            x1 = max(C.shape[1] - r[0], S.shape[1] - sreg[0]); y1 = max(C.shape[0] - r[1], S.shape[0] - sreg[1])
            a = place(C, r, (x0, y0, x1, y1)); b = place(S, sreg, (x0, y0, x1, y1))
            oa = a[..., 3] >= 128; ob = b[..., 3] >= 128
            union = oa | ob
            if not union.any(): continue
            both = oa & ob
            d = np.sqrt(((a[..., :3] - b[..., :3]) ** 2).sum(-1)) / 441.7
            err = np.where(both, np.minimum(1, d * 2.5), 1.0)[union]
            exact = (both & (d < 0.02))[union].mean()
            e = err.mean()
            if best is None or e < best[0]: best = (e, exact, (dx, dy))
    return best

def creg_of(reg, ox=0, oy=0):
    """Registration point of a halved picture whose blocks start at phase (ox, oy)."""
    return ((reg[0] + ox) // 2, (reg[1] + oy) // 2)

def evaluate(method, pairs, phases=((0, 0),), **kw):
    errs, exacts = [], []
    for p in pairs:
        best = None
        for (ox, oy) in phases:
            C = method(pad_even(p['L'], ox, oy), **kw)
            s = score(C, creg_of(p['reg'], ox, oy), p['S'], p['sreg'])
            if s and (best is None or s[0] < best[0]): best = s
        if best: errs.append(best[0]); exacts.append(best[1])
    return float(np.mean(errs)), float(np.mean(exacts)), len(errs)

def inner_score(C, creg, S, sreg):
    """Of the inside of Sulake's picture (not its outline): the pixels a candidate has the same, and of its small
    details (pixels unlike most of their neighbours). Returns (share, details hit, details, inside hit, inside,
    pixels only one of the two has, pixels either has)."""
    best = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            r = (creg[0] + dx, creg[1] + dy)
            x0 = min(-r[0], -sreg[0]); y0 = min(-r[1], -sreg[1])
            x1 = max(C.shape[1] - r[0], S.shape[1] - sreg[0]); y1 = max(C.shape[0] - r[1], S.shape[0] - sreg[1])
            a = place(C, r, (x0, y0, x1, y1)); b = place(S, sreg, (x0, y0, x1, y1))
            ob = b[..., 3] >= 128; oa = a[..., 3] >= 128
            pad = np.pad(ob, 1)
            inner = ob & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
            bp = np.pad(b[..., :3], ((1, 1), (1, 1), (0, 0)), mode='edge')
            diff = sum((np.abs(bp[1 + j: 1 + j + b.shape[0], 1 + i: 1 + i + b.shape[1]] - b[..., :3]).sum(-1) > 60).astype(int) for j in (-1, 0, 1) for i in (-1, 0, 1) if (i, j) != (0, 0))
            detail = inner & (diff >= 5)
            d = np.sqrt(((a[..., :3] - b[..., :3]) ** 2).sum(-1)) / 441.7
            hit = oa & (d < 0.04)
            if not inner.any(): continue
            q = hit[inner].mean()
            if best is None or q > best[0]: best = (q, hit[detail].sum(), detail.sum(), hit[inner].sum(), inner.sum(), (oa ^ ob).sum(), (oa | ob).sum())
    return best


class Model:
    def __init__(self, path='model.npz'):
        d = np.load(path)
        self.mu, self.sd = d['mu'], d['sd']
        n = len([k for k in d.files if k.startswith('W')])
        self.W = [d['W%d' % i] for i in range(n)]; self.B = [d['B%d' % i] for i in range(n)]
    def logits(self, X):
        a = (X - self.mu) / self.sd
        for i in range(len(self.W)):
            a = a @ self.W[i] + self.B[i]
            if i < len(self.W) - 1: a = np.maximum(a, 0)
        return a
