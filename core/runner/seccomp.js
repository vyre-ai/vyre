// @ts-check
// A seccomp filter for the Linux sandbox (reviewer-2 item 9). bubblewrap already drops capabilities and nested user namespaces; this
// adds a deny list of the system calls a session never needs and that widen an escape: ptrace and process_vm_*, bpf, perf_event_open,
// keyctl, add_key and request_key, unshare and setns, mount and pivot_root, kexec, module loading, reboot, swap, userfaultfd and
// open_by_handle_at. Everything else is allowed. It is a classic BPF program handed to bubblewrap with --seccomp FD.

const EPERM = 1;
const ARCH = { x64: { id: 0xC000003E, nr: { ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, keyctl: 250, add_key: 248, request_key: 249, bpf: 321, perf_event_open: 298, unshare: 272, setns: 308, mount: 165, umount2: 166, pivot_root: 155, kexec_load: 246, init_module: 175, finit_module: 313, delete_module: 176, reboot: 169, swapon: 167, swapoff: 168, userfaultfd: 323, open_by_handle_at: 304 } },
  arm64: { id: 0xC00000B7, nr: { ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, keyctl: 219, add_key: 217, request_key: 218, bpf: 280, perf_event_open: 241, unshare: 97, setns: 268, mount: 40, umount2: 39, pivot_root: 41, kexec_load: 104, init_module: 105, finit_module: 273, delete_module: 106, reboot: 142, swapon: 224, swapoff: 225, userfaultfd: 282, open_by_handle_at: 265 } } };

/** The filter for this machine's architecture as a Buffer of sock_filter structs, or null when the architecture is not covered. @param {string} [arch] */
export function filter(arch = process.arch) {
  const a = arch === "x64" ? ARCH.x64 : arch === "arm64" ? ARCH.arm64 : null;
  if (!a) return null;
  const nrs = Object.values(a.nr);
  const ins = [];
  const op = (code, jt, jf, k) => ins.push([code, jt, jf, k >>> 0]);
  op(0x20, 0, 0, 4);                       // ld arch
  op(0x15, 1, 0, a.id);                    // arch matches: skip the next instruction
  op(0x06, 0, 0, 0x00050000 | EPERM);      // another architecture (x32, i386): refuse
  op(0x20, 0, 0, 0);                       // ld syscall number
  nrs.forEach((nr, i) => op(0x15, nrs.length - i, 0, nr));   // a listed call jumps to the final refusal
  op(0x06, 0, 0, 0x7fff0000);              // allow
  op(0x06, 0, 0, 0x00050000 | EPERM);      // refuse
  const buf = Buffer.alloc(ins.length * 8);
  ins.forEach(([c, jt, jf, k], i) => { buf.writeUInt16LE(c, i * 8); buf[i * 8 + 2] = jt; buf[i * 8 + 3] = jf; buf.writeUInt32LE(k, i * 8 + 4); });
  return buf;
}
