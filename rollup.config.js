import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import cleanup from "rollup-plugin-cleanup";

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
        !sourcemap ? cleanup() : undefined,
        !sourcemap ? terser() : undefined
    ],
    // 用来指定代码执行环境的参数，解决this执行undefined问题 
    context: 'window',
});

export default [
    output('./dist/xktloader.js', 'umd', true),
    output('./dist/xktloader.min.js', 'umd', false),
    output('./dist/xktloader.esm.js', 'esm', true),
    output('./dist/xktloader.esm.min.js', 'esm', false),
]