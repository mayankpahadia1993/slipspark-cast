(function (root) {
  "use strict";
  // Bound the workspace even if a future atlas contains an unexpectedly large pose.
  const MAX_BYTES = 4 * 1024 * 1024;
  function createDyer(instance, core) {
    const { memory, dye, __heap_base } = instance.exports;
    const configAt = Math.ceil(__heap_base.value / 8) * 8;
    const pixelsAt = configAt + 28 * 8;
    return function (rgba, mask, look, gearMask, gear) {
      const size = rgba.length;
      if (!size || size % 4 || size > MAX_BYTES || (mask && mask.length !== size) || (gearMask && gearMask.length !== size)) return false;
      const need = pixelsAt + size * 3;
      if (memory.buffer.byteLength < need) memory.grow(Math.ceil((need - memory.buffer.byteLength) / 65536));
      const bytes = new Uint8Array(memory.buffer), config = new Float64Array(memory.buffer, configAt, 28);
      const colours = look && mask ? core.lookColours(look) : [null, null, null];
      const worn = gear && gearMask ? core.gearColours(gear) : {};
      let flags = 0;
      config.fill(0);
      colours.forEach((colour, index) => { if (colour) { flags |= 1 << index; config.set(colour, index * 3); } });
      if (worn.helmet) { flags |= 8; config.set(worn.helmet.shell, 9); config.set(worn.helmet.shade, 12); }
      if (worn.pads) { flags |= 16; config.set(worn.pads, 14); }
      if (worn.bat) {
        flags |= 32; config.set(worn.bat.sticker, 17); config.set(worn.bat.shade, 23);
        if (worn.bat.finish) { flags |= 64; config.set(worn.bat.finish, 20); }
      }
      config[25] = core.GRIP_OPACITY; config.set(core.GRIP_SHADE, 26);
      bytes.set(rgba, pixelsAt);
      if (mask) bytes.set(mask, pixelsAt + size);
      if (gearMask) bytes.set(gearMask, pixelsAt + size * 2);
      dye(pixelsAt, pixelsAt + size, pixelsAt + size * 2, configAt, size, flags);
      rgba.set(bytes.subarray(pixelsAt, pixelsAt + size));
      return true;
    };
  }
  if (typeof module === "object" && module.exports) { module.exports = { createDyer }; return; }
  const core = root.RallycadeSceneCore;
  let generation = 0, active = null, loading = null;
  const suffix = document.currentScript ? new URL(document.currentScript.src).search : "";
  const compiled = typeof WebAssembly === "object"
    ? fetch("receiver-dye.wasm" + suffix).then((r) => { if (!r.ok) throw new Error("dye unavailable"); return r.arrayBuffer(); }).then((bytes) => WebAssembly.compile(bytes)).catch(() => null)
    : Promise.resolve(null);
  function prepare() {
    if (active) return Promise.resolve(true);
    if (loading) return loading;
    const mine = generation;
    const work = compiled.then((module) => {
      if (!module || mine !== generation) return false;
      active = createDyer(new WebAssembly.Instance(module), core);
      return true;
    }).catch(() => false).finally(() => { if (loading === work) loading = null; });
    loading = work;
    return work;
  }
  root.RallycadeDye = {
    prepare,
    release() { generation += 1; active = null; loading = null; },
    dyeFrame(...args) {
      if (!active) return false;
      try { return active(...args); } catch (error) { active = null; return false; }
    }
  };
  prepare();
})(typeof globalThis !== "undefined" ? globalThis : this);
