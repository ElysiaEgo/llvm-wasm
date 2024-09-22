import { init, WASI } from 'https://esm.sh/@wasmer/wasi@1.1.2'
import Clang from './clang.js'
import Lld from './lld.js'

await init()

export const compileAndRun = async (mainC) => {
    console.time('clang compile')
    const clang = await Clang()
    clang.FS.writeFile('main.cpp', mainC)
    await clang.callMain([
        '-std=c++23',
        '-c',
        'main.cpp'
    ])
    console.timeEnd('clang compile')
    const mainO = clang.FS.readFile('main.o')

    console.time('lld link')
    const lld = await Lld()
    lld.FS.writeFile('main.o', mainO)
    await lld.callMain([
        '-flavor',
        'wasm',
        '-L/lib/wasm32-wasi',
        '-lc',
        '-lc++',
        '-lc++abi',
        '/lib/clang/18/lib/wasi/libclang_rt.builtins-wasm32.a',
        '/lib/wasm32-wasi/crt1.o',
        'main.o',
        '-o',
        'main.wasm',
    ])
    console.timeEnd('lld link')
    const mainWasm = lld.FS.readFile('main.wasm')

    const wasi = new WASI({})
    const module = await WebAssembly.compile(mainWasm)
    const instance = await WebAssembly.instantiate(module, {
        ...wasi.getImports(module)
    })

    wasi.start(instance)
    const stdout = await wasi.getStdoutString()
    return stdout
}
