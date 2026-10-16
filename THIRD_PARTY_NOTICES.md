# Third-party engine

Online Chess includes **Stockfish.js 19.0.1**, based on Stockfish 19, by the Stockfish contributors, Nathan Rugg and contributors. The chosen build is `stockfish-19-lite-single`.

- License: **GNU General Public License, version 3** (GPL-3.0).
- Upstream and corresponding source for the pinned release: https://github.com/nmrugg/stockfish.js/tree/v19.0.1
- Source archive: https://github.com/nmrugg/stockfish.js/archive/refs/tags/v19.0.1.tar.gz
- Original Stockfish: https://github.com/official-stockfish/Stockfish

The engine JavaScript and WASM are distributed unchanged. `scripts/prepare-stockfish.mjs` copies the license to `public/engine/Copying.txt` and generates `public/engine/SOURCE.txt` with source-access information. Vite includes these files in `dist/engine`, and the game screen links to both. Keep the license and corresponding-source information when distributing the engine.

The repository's existing MIT license remains in `LICENSE`; it does not relicense the Stockfish engine. Other npm dependencies retain their own licenses in their packages.
