/** Wait for every promise, but no longer than ms: true when it gave up, false when they all settled in time. */
export async function boundedWait(promises, ms) {
  let timer;
  try {
    return await Promise.race([Promise.all(promises).then(() => false), new Promise(r => { timer = setTimeout(() => r(true), ms); })]);
  } finally { clearTimeout(timer); }
}
