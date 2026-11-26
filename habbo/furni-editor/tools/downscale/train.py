# python3 train.py train.npz 5 128,64 30 model.npz [all]
# A small network (numpy only) on feat.py's samples: which pixel of a 2x2 block Sulake kept. `all` trains on the
# held-out furni too (the model that ships); without it the test numbers are for furni it has not seen.
import numpy as np, time, sys
data, ncls, hidden, epochs, outp = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), sys.argv[5]
d = np.load(data)
Xtr, Ytr, Ttr, Xte, Yte, Tte = [d[k] for k in ('Xtr', 'Ytr', 'Ttr', 'Xte', 'Yte', 'Tte')]
if len(sys.argv) > 6 and sys.argv[6] == 'all':
    Xtr = np.concatenate([Xtr, Xte]); Ytr = np.concatenate([Ytr, Yte]); Ttr = np.concatenate([Ttr, Tte])
mu = Xtr.mean(0); sd = np.maximum(Xtr.std(0), 0.05)
Xtr -= mu; Xtr /= sd; Xte = (Xte - mu) / sd
rng = np.random.default_rng(0)
sizes = [Xtr.shape[1]] + [int(x) for x in hidden.split(',')] + [ncls]
W = [rng.normal(0, np.sqrt(2 / sizes[i]), (sizes[i], sizes[i + 1])).astype(np.float32) for i in range(len(sizes) - 1)]
B = [np.zeros(sizes[i + 1], np.float32) for i in range(len(sizes) - 1)]
mW = [np.zeros_like(w) for w in W]; vW = [np.zeros_like(w) for w in W]; mB = [np.zeros_like(b) for b in B]; vB = [np.zeros_like(b) for b in B]
def forward(X):
    acts = [X]
    for i in range(len(W)):
        z = acts[-1] @ W[i] + B[i]
        acts.append(np.maximum(z, 0) if i < len(W) - 1 else z)
    return acts
def acc(X, Y):
    pred = np.concatenate([forward(X[i:i + 65536])[-1].argmax(1) for i in range(0, len(X), 65536)])
    return (pred == Y).mean()
lr0, bs, step = 1e-3, 1024, 0
n = len(Xtr); t0 = time.time(); best = (0, None)
for ep in range(epochs):
    perm = rng.permutation(n); lr = lr0 * (0.5 ** (ep // 8))
    for i in range(0, n, bs):
        idx = perm[i:i + bs]; x, y, t = Xtr[idx], Ytr[idx], Ttr[idx]
        acts = forward(x)
        z = acts[-1]; z = z - z.max(1, keepdims=True)
        p = np.exp(z); p /= p.sum(1, keepdims=True)
        g = p; g[np.arange(len(y)), y] -= 1; g *= (t / len(y))[:, None]
        step += 1
        for k in range(len(W) - 1, -1, -1):
            gw = acts[k].T @ g + 1e-5 * W[k]; gb = g.sum(0)
            if k > 0: g = (g @ W[k].T) * (acts[k] > 0)
            for (par, grad, m, v) in ((W[k], gw, mW[k], vW[k]), (B[k], gb, mB[k], vB[k])):
                m *= 0.9; m += 0.1 * grad; v *= 0.999; v += 0.001 * grad * grad
                par -= lr * (m / (1 - 0.9 ** step)) / (np.sqrt(v / (1 - 0.999 ** step)) + 1e-8)
    if ep % 3 == 2 or ep == epochs - 1:
        a = acc(Xte, Yte)
        print('epoch %2d  train %.4f  test %.4f  %.0fs' % (ep + 1, acc(Xtr[:200000], Ytr[:200000]), a, time.time() - t0), flush=True)
        if a > best[0]: best = (a, ([w.copy() for w in W], [b.copy() for b in B]))
W, B = best[1]
np.savez(outp, mu=mu, sd=sd, **{'W%d' % i: w for i, w in enumerate(W)}, **{'B%d' % i: b for i, b in enumerate(B)})
print('kept test accuracy', best[0])
