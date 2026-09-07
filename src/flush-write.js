export function flushWrite(write, text) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };
    try {
      write(text, done);
    } catch (err) {
      done(err);
    }
  });
}
