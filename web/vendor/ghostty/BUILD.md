# The terminal kernel

The client draws the panes with the VT of Ghostty, compiled to WebAssembly.

| | |
|---|---|
| Sources | [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty) at `v1.4.0` |
| Module | `ghostty-vt.wasm`, built by `scripts/build-ghostty-vt.sh` |
| License | MIT, see `LICENSE` |

The build keeps the render state of the library and nothing else:

```
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall \
  -Dvt-features=-all,+render-state
```

The client reads the screen of a pane through the render state, so the other
features of the library would only make the module bigger. The optimizer of
[binaryen](https://github.com/WebAssembly/binaryen) has the last word on the
size of the file that is kept here.
