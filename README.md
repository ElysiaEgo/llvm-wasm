Quick (incomplete) overview of the compilation process w/ LLVM:
```
*.c
 |
 | clang -cc1
 v
*.ll
 |         ^
 | llvm-as | llvm-dis
 v         |
*.bc
 |
 | llvm-link + *.a (native static libs) + *.bc (bitcode)
 v
*.bc
 |
 | llc
 v
*.s
 |
 | as
 v
*.o
 |
 | lld + *.a (native static libs) + *.o (native obj files)
 v
 🎉 (native binary)
```

There are many prior arts to getting parts of the LLVM toolchain running on the browser:
- Alon Zakai's [llvm.js](http://kripken.github.io/llvm.js/demo.html) [GitHub](https://github.com/kripken/llvm.js)

This is perhaps the first successful attempt at this. It (appears to?) execute the LLVM IR directly using an earlier version of Emscripten (which was in JavaScript). `llvm-as` and `llvm-dis` are used for LLVM IR validation and pretty-printing. This approach probably doesn't work anymore as Emscripten (or at least the SDK) now requires Node.js and Python, among other things.
- Todd Fleming's [cib](https://tbfleming.github.io/cib/) [GitHub](https://github.com/tbfleming/cib)

This (appears to?) compile `clang` along with a ([bespoke?](https://github.com/tbfleming/cib/blob/master/src/rtl/CMakeLists.txt)) WASM runtime with Emscripten. No idea how all this works, the build scripts are... not pretty.
- Ben Smith's [wasm-clang](https://binji.github.io/wasm-clang/) [GitHub](https://github.com/binji/wasm-clang)

This is the latest attempt I can find, and makes use of [WASI](https://github.com/bytecodealliance/wasmtime/blob/main/docs/WASI-intro.md). It compiles `clang` and `lld` to WASI using a [hacked LLVM source](https://github.com/binji/llvm-project). It gets access to libc through a custom in-memory file system.

The approach done here is a mix between `llvm.js` and `wasm-clang`: we compile `llc` & `lld` using Emscripten. `llc` is used to compile the LLVM IR to a wasm32-wasi object file. The object file is run through `lld` along with (WASI) libc into a wasm32-wasi binary.

For `lld` to find libc, we need to create an in-memory file system, like in `wasm-clang`. Fortunately, Emscripten provides this, so all we need to do is to `tar` up the WASI sysroot (which includes libc), and write it into the file system on client-side.

After running the linker, we now have a wasm binary, but this isn't enough to run it on the browser. WASI hasn't been standardized yet, so there isn't native browser support for it, so we need some sort of polyfill. Fortunately, Wasmer provides just that with [@wasmer/wasi](https://github.com/wasmerio/wasmer-js/tree/master/packages/wasi), which they used for e.g. [wasm-terminal](https://www.infoq.com/news/2019/10/wasmer-js-wasi-wasm-browser/).

And with that, we can run the wasm binary and you're off to the races! :)

Now for the build steps...
# `llc` & `lld`
For this, you'll want a fairly beefy machine, because we have no choice but to build the LLVM toolchain. I used AWS EC2 c5a.8xlarge with 30GB storage (this is fairly expensive, so **STOP** the instance once you're done).
## Packages
```sh
sudo apt-get update
sudo apt-get -y dist-upgrade
sudo apt-get -y install cmake g++ git ninja-build python3
```
## Emscripten
```sh
git clone https://github.com/emscripten-core/emsdk
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
echo "source $PWD/emsdk_env.sh" >> $HOME/.bash_profile
cd ..
```
## `clang-tblgen` & `llvm-tblgen`
Before you cross-compile LLVM, you need to build `clang-tblgen` & `llvm-tblgen` for the host.
```sh
git clone https://github.com/llvm/llvm-project
cd llvm-project
cmake -G Ninja -S llvm -B build-host \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_PROJECTS=clang
cmake --build build-host --target clang-tblgen llvm-tblgen
```
## Cross build
If you want to toy around with the build options, you might want to base it on the debug build (and save yourself some aneurysms and cloud credits). Otherwise use the release build.

Debug build:
```sh
EMCC_DEBUG=2 emcmake cmake -G Ninja -S llvm -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CROSSCOMPILING=True \
  -DCMAKE_INSTALL_PREFIX=install \
  -DCMAKE_CXX_FLAGS='-g2 -s ASSERTIONS=2 -s SAFE_HEAP -s STACK_OVERFLOW_CHECK=2 -s DEMANGLE_SUPPORT -s MALLOC=emmalloc-debug -s EXCEPTION_DEBUG -s PTHREADS_DEBUG -s ABORT_ON_WASM_EXCEPTIONS -s NO_INVOKE_RUN -s EXIT_RUNTIME -s ALLOW_MEMORY_GROWTH -s INITIAL_MEMORY=64MB -s MODULARIZE -s EXPORT_ES6 -s EXTRA_EXPORTED_RUNTIME_METHODS=["callMain","FS"]' \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi \
  -DLLVM_TARGET_ARCH=wasm32-emscripten \
  -DLLVM_ENABLE_PROJECTS=lld \
  -DLLVM_TABLEGEN=$PWD/build-host/bin/llvm-tblgen
cmake --build build
```
Release build:
```sh
emcmake cmake -G Ninja -S llvm -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CROSSCOMPILING=True \
  -DCMAKE_INSTALL_PREFIX=install \
  -DCMAKE_CXX_FLAGS='-O3 -s NO_ASSERTIONS -s NO_INVOKE_RUN -s EXIT_RUNTIME -s ALLOW_MEMORY_GROWTH -s INITIAL_MEMORY=64MB -s MODULARIZE -s EXPORT_ES6 -s EXTRA_EXPORTED_RUNTIME_METHODS=["callMain","FS"]' \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi \
  -DLLVM_TARGET_ARCH=wasm32-emscripten \
  -DLLVM_ENABLE_PROJECTS=lld \
  -DLLVM_TABLEGEN=$PWD/build-host/bin/llvm-tblgen
cmake --build build
```
## Download build artifacts
```sh
cd build
tar -czvf bin.tgz bin/{llc,lld}.*
```
Locally:
```sh
scp <build-machine-address>:~/llvm-project/build/bin.tgz .
```
Now you can stop the build machine instance. You should have `llc.js`, `llc.wasm`, `lld.js`, `lld.wasm` on your local machine.
# WASI sysroot
As mentioned in the preface, we need the WASI sysroot to provide the linker with libc. You also need the clang compiler runtime. Get these [here](https://github.com/WebAssembly/wasi-sdk/releases). These are `wasi-sysroot-x.y.tar.gz` and `libclang_rt.builtins-wasm32-wasi-x.y.tar.gz` respectively. Then bundle & `tar` them up.
# WASI browser polyfill
We use [@wasmer/wasi](https://github.com/wasmerio/wasmer-js/tree/master/packages/wasi) as the WASI polyfill. The npm packages we need are:
- `@wasmer/wasi`
- `@wasmer/wasmfs`
- `@wasmer/wasi/lib/bindings/browser`

As of this writing, there was a problem when importing the browser bindings from a CDN (e.g. Skypack), so I had to manually build them with a modified Rollup config. If you don't want to mess with this, just use `browserBindings.js` from the repo.
# Etc.
For more details on how to use the WASI sysroot and polyfill, feel free to pore through `index.js`. These references might be helpful:
- [Emscripten's File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html#filesystem-api)
- [sysroot untar()-ing code](https://github.com/binji/wasm-clang/blob/8e78cdb9caa80f75ed86d6632cb4e9310b22748c/shared.js#L580-L652) from `wasm-clang`
- [@wasmer/wasi docs](https://docs.wasmer.io/integrations/js/reference-api/wasmer-wasi)

Good luck!