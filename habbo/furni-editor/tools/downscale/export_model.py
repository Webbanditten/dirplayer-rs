# python3 export_model.py <model.npz> <out.ts> <out_q.npz>: fold the normalisation into the first layer, store 16-bit weights.
import numpy as np, sys, base64
src, out_ts, out_q = sys.argv[1:4]
d = np.load(src)
n = len([k for k in d.files if k.startswith('W')])
W = [d['W%d' % i].astype(np.float64) for i in range(n)]; B = [d['B%d' % i].astype(np.float64) for i in range(n)]
mu, sd = d['mu'].astype(np.float64), d['sd'].astype(np.float64)
B[0] = B[0] - (mu / sd) @ W[0]; W[0] = W[0] / sd[:, None]
tensors = {}; q = {}
for name, t in [('W%d' % i, W[i]) for i in range(n)] + [('B%d' % i, B[i]) for i in range(n)]:
    scale = float(np.abs(t).max()) / 32767 or 1.0
    i16 = np.round(t / scale).astype('<i2')
    tensors[name] = (scale, base64.b64encode(i16.tobytes()).decode())
    q[name] = (i16.astype(np.float32) * np.float32(scale)).reshape(t.shape)
sizes = [W[0].shape[0]] + [w.shape[1] for w in W]
with open(out_ts, 'w') as f:
    f.write("// Made by a training script from the hotel's own large and small furni pictures: see downscale.ts. Not written by hand.\n")
    f.write('// Per tensor: 16-bit numbers (little-endian, base64) and the step they count in. Layer i maps sizes[i] to sizes[i + 1].\n')
    f.write('export const MODEL: { sizes: number[]; tensors: Record<string, { scale: number; data: string }> } = {\n')
    f.write('  sizes: %s,\n  tensors: {\n' % sizes)
    for name, (scale, data) in tensors.items():
        f.write("    %s: { scale: %r, data: '%s' },\n" % (name, scale, data))
    f.write('  },\n};\n')
np.savez(out_q, mu=np.zeros(sizes[0], np.float32), sd=np.ones(sizes[0], np.float32), **q)
print('sizes', sizes, 'ts bytes', sum(len(v[1]) for v in tensors.values()))
