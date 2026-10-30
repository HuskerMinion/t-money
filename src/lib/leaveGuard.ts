// Save the open transaction before Back or Forward takes the screen away.
//
// The register saves its open form when you click another row or another
// account, but Back and Forward remount the whole view: without this, a
// half-typed transaction would simply be gone. The register sets the guard
// while it is on screen; the shell asks it before moving.
type Leave = () => Promise<"saved" | "clean" | "failed">;

let current: Leave | null = null;

/** Set the guard; returns the function that clears it. */
export function setLeaveGuard(leave: Leave): () => void {
  current = leave;
  return () => {
    if (current === leave) current = null;
  };
}

/** Save what is open. False = it could not be saved (the form says why),
 *  so stay where you are. */
export async function leaveScreen(): Promise<boolean> {
  if (!current) return true;
  return (await current()) !== "failed";
}
