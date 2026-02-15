class Bqubo {
    constructor(qubo, params = {}) {
        this.qubo = qubo;
        this.params = {
            kTinit: parseFloat(params.kTinit) || 10.0,
            cl: parseFloat(params.cl) || 0.995,
            kTF: parseFloat(params.kTF) || 0.01,
            rpt: parseInt(params.rpt) || 20000 
        };
    }

    async solve(onStep) {
        const workerCode = `
            self.onmessage = function(e) {
                const { n, linear, adjTo, adjWeight, adjCount, offsets, kTinit, cl, kTF, rpt } = e.data;
                const state = new Uint8Array(n);
                for(let i=0; i<n; i++) state[i] = Math.random() > 0.5 ? 1 : 0;
                
                let kT = kTinit;
                while(kT > kTF) {
                    for (let r = 0; r < rpt; r++) {
                        const i = (Math.random() * n) | 0;
                        let localField = linear[i];
                        
                        // 修正：offsets を使用して、そのノードに隣接するデータのみを正確に参照
                        const start = offsets[i];
                        const count = adjCount[i];
                        
                        for (let k = 0; k < count; k++) {
                            const idx = start + k;
                            if (state[adjTo[idx]] === 1) {
                                localField += adjWeight[idx];
                            }
                        }
                        
                        const deltaE = (state[i] === 0) ? localField : -localField;
                        if (deltaE <= 0 || Math.random() < Math.exp(-deltaE / kT)) {
                            state[i] ^= 1;
                        }
                    }
                    kT *= cl;
                    self.postMessage({ state, kT, finished: false });
                }
                self.postMessage({ state, kT, finished: true });
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));

        const rawNodes = Array.from(new Set(Object.keys(this.qubo).flatMap(k => k.split(',').map(Number)))).sort((a,b)=>a-b);
        const map = new Map(rawNodes.map((n, i) => [n, i]));
        const N = rawNodes.length;

        const linear = new Float64Array(N);
        const tempAdj = Array.from({ length: N }, () => []);
        let totalEdges = 0;

        for (let key in this.qubo) {
            const parts = key.split(',').map(Number);
            const w = this.qubo[key];
            const i = map.get(parts[0]);
            if (parts.length === 1 || parts[0] === parts[1]) {
                linear[i] += w;
            } else {
                const j = map.get(parts[1]);
                tempAdj[i].push({to: j, w: w});
                tempAdj[j].push({to: i, w: w});
                totalEdges += 2;
            }
        }

        // 密な行列(N*N)ではなく、必要な分だけ確保
        const adjTo = new Int32Array(totalEdges);
        const adjWeight = new Float64Array(totalEdges);
        const adjCount = new Int32Array(N);
        const offsets = new Int32Array(N);

        let currentPos = 0;
        for (let i = 0; i < N; i++) {
            offsets[i] = currentPos;
            adjCount[i] = tempAdj[i].length;
            for (let edge of tempAdj[i]) {
                adjTo[currentPos] = edge.to;
                adjWeight[currentPos] = edge.w;
                currentPos++;
            }
        }

        return new Promise((resolve) => {
            worker.postMessage({
                n: N, linear, adjTo, adjWeight, adjCount, offsets,
                ...this.params
            }, [linear.buffer, adjTo.buffer, adjWeight.buffer, adjCount.buffer, offsets.buffer]);

            worker.onmessage = (e) => {
                const { state, kT, finished } = e.data;
                const readableState = {};
                rawNodes.forEach((node, idx) => readableState[node] = state[idx]);
                if (onStep) onStep(readableState, kT);
                if (finished) {
                    worker.terminate();
                    URL.revokeObjectURL(blob);
                    resolve(readableState);
                }
            };
        });
    }
}