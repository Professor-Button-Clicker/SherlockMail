const AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

// Every caller waiting on an OAuth callback gets an answer: a second "Authorize" click must not
// orphan the first request, and an abandoned sign-in must not hold a connection open forever.
export function createAuthWaiters() {
  let waiters = [];
  const settle = (result) => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      w.resolve(result);
    }
  };
  return {
    wait() {
      return new Promise((resolve) => {
        const waiter = { resolve };
        waiter.timer = setTimeout(() => {
          waiters = waiters.filter(w => w !== waiter);
          resolve({ error: 'Authorization timed out after 5 minutes. Click Authorize to try again.' });
        }, AUTH_WAIT_TIMEOUT_MS);
        waiters.push(waiter);
      });
    },
    settle,
  };
}
