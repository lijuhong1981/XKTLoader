import { nodeResolve } from '@rollup/plugin-node-resolve';
import { terser } from 'rollup-plugin-terser';

const output = (file, format, sourcemap) => ({
    input: './src/index.js',
    output: {
        name: 'xktloader',
        file,
        format,
        sourcemap,
    },
    plugins: [
        nodeResolve({
            browser: true,
            preferBuiltins: false
        }),
        !sourcemap ? terser() : undefined
    ]
});

export default [
    output('./dist/xktloader.js', 'umd', true),
    output('./dist/xktloader.min.js', 'umd', false),
    output('./dist/xktloader.esm.js', 'esm', true),
    output('./dist/xktloader.esm.min.js', 'esm', false),
]