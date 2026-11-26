# The reference for the editor's src/downscale.ts: the same decisions in numpy. vectors.py + parity.ts check that the
# TypeScript gives the same pixels. Run it to score the model on furni it has not seen.
import numpy as np, sys
from lab import *
from feat import windows, features, CAND, is_test

def close_outline(out, Lp, dark=72):
    """The outer outline stays closed: a pixel on the edge of the shape takes its block's darkest pixel when the block
    has an outline-dark one; an empty block with an outline pixel next to the shape joins the outline."""
    win = windows(Lp)
    cand = np.stack([win[:, :, y, x] for (y, x) in CAND], 2)
    cop = cand[..., 3] >= 128
    lm = np.where(cop, lum(cand[..., :3]), 999.0)
    op = out[..., 3] >= 128
    pad = np.pad(op, 1)
    near = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
    has_dark = (lm < dark).any(2)
    op2 = op | (has_dark & near & (cop.sum(2) >= 2))
    pad = np.pad(op2, 1)
    edge = op2 & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    k = lm.argmin(2)
    darkest = np.take_along_axis(cand, k[..., None, None].repeat(4, -1), 2)[:, :, 0]
    use = edge & has_dark
    res = out.copy(); res[use] = darkest[use].astype(np.uint8); res[use, 3] = 255
    return res

FLIP = [1, 0, 3, 2, 4]
TEXTURE = 0.85
BLEND = 64

def textured(win, op):
    """per block: only solid pixels around it, and nearly every pair of neighbours in its 6x6 window differs"""
    c = win[..., :3].astype(np.int32)
    dh = (np.abs(c[:, :, 1:] - c[:, :, :-1]).sum(-1) > 0) & op[:, :, 1:] & op[:, :, :-1]
    dv = (np.abs(c[:, 1:] - c[:, :-1]).sum(-1) > 0) & op[:, 1:] & op[:, :-1]
    pairs = (op[:, :, 1:] & op[:, :, :-1]).sum((1, 2)) + (op[:, 1:] & op[:, :-1]).sum((1, 2))
    diff = dh.sum((1, 2)) + dv.sum((1, 2))
    return diff >= TEXTURE * pairs

def final_halve2(Lp, model, sym=True, texture=False, dark=72):
    win = windows(Lp); h, w = win.shape[:2]
    flat = win.reshape(h * w, 6, 6, 4)
    op = flat[..., 3] >= 128
    cand = np.stack([flat[:, y, x] for (y, x) in CAND], 1)
    cop = cand[..., 3] >= 128
    out = np.zeros((h * w, 4), np.uint8); out[:, :3] = 255
    some = cop.any(1)
    ring = op[:, 1:5, 1:5].all((1, 2))
    uniform = cop.all(1) & (np.abs(cand[:, :, :3] - cand[:, :1, :3]).sum(-1) == 0).all(1)
    easy = some & uniform & ring
    out[easy] = cand[easy, 0].astype(np.uint8)
    hard = some & ~easy
    if hard.any():
        c = cand[hard]
        def probs(z):
            z = z.astype(np.float64)
            z[:, :4] = np.where(cop[hard], z[:, :4], -1e9)
            z[:, 4] = np.where(ring[hard], -1e9, z[:, 4])
            z = z - z.max(1, keepdims=True); p = np.exp(z)
            return p / p.sum(1, keepdims=True)
        p = probs(model.logits(features(flat[hard])))
        if sym:
            # the same question asked of the mirror image; candidates of one colour share their votes
            p = p + probs(model.logits(features(flat[hard][:, :, ::-1]))[:, FLIP])
            same = (np.abs(c[:, :, None, :3] - c[:, None, :, :3]).sum(-1) == 0) & cop[hard][:, :, None] & cop[hard][:, None, :]
            p = np.concatenate([(same * p[:, None, :4]).sum(2), p[:, 4:]], 1)
        k = p.argmax(1)
        out[hard] = np.where((k < 4)[:, None], c[np.arange(len(k)), np.minimum(k, 3)], np.array([255, 255, 255, 0], np.float32)).astype(np.uint8)
    out[out[:, 3] >= 128, 3] = 255
    res = close_outline(out.reshape(h, w, 4), Lp, dark)
    if texture:
        # a 32-bit picture can hold any colour: the block's pixels close to the picked one are averaged in
        cf = cand.reshape(h, w, 4, 4).astype(np.int64); solid = cf[..., 3] >= 128
        d2 = ((cf[..., :3] - res[:, :, None, :3].astype(np.int64)) ** 2).sum(-1)
        near = solid & (d2 <= BLEND * BLEND); n = near.sum(2)
        mean = (cf[..., :3] * near[..., None]).sum(2) / np.maximum(1, n)[..., None]
        use = (res[..., 3] >= 128) & (n > 0)
        res[use, :3] = np.floor(mean[use] + 0.5).astype(np.uint8)
        t = (ring & textured(flat, op)).reshape(h, w)
        avg = np.floor(cand[:, :, :3].astype(np.float64).mean(1) + 0.5).astype(np.uint8).reshape(h, w, 3)
        res[t, :3] = avg[t]
    return res

if __name__ == '__main__':
    model = Model(sys.argv[1])
    pairs = [p for p in load_pairs() if is_test(p['cls'])]
    print(len(pairs), 'pictures of', len(set(p['cls'] for p in pairs)), 'unseen furni')
    for name, fn in [('earlier halving', lambda L: current(L, mode=True)), ('picked', lambda L: final_halve2(L, model))]:
        hd = td = hi = ti = sx = su = 0; errs = []
        for p in pairs:
            ox, oy = p['reg'][0] % 2, p['reg'][1] % 2
            C = fn(pad_even(p['L'], ox, oy)); creg = ((p['reg'][0] + ox) // 2, (p['reg'][1] + oy) // 2)
            s = inner_score(C, creg, p['S'], p['sreg'])
            if s: hd += s[1]; td += s[2]; hi += s[3]; ti += s[4]; sx += s[5]; su += s[6]
            e = score(C, creg, p['S'], p['sreg'])
            if e: errs.append(e[0])
        print('%-26s error %.4f  inside same %.1f%%  details same %.1f%%  shape differs %.1f%%' % (name, np.mean(errs), 100 * hi / ti, 100 * hd / max(1, td), 100 * sx / su), flush=True)
