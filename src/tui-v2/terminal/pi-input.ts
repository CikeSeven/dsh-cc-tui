/** Production-safe pi input facade; no process terminal/screen exports. */
export { StdinBuffer } from '../vendor/pi-tui/src/stdin-buffer.js'
export {
  decodePrintableKey,
  isKeyRelease,
  isKeyRepeat,
  parseKey,
  setKittyProtocolActive,
} from '../vendor/pi-tui/src/keys.js'
