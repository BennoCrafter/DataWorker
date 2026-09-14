/**
 * Client-side UI state — plain module-level object, mutated directly and re-rendered by the
 * render functions of the owning modules. Extend it with your app's state.
 */

export const state = {
	showActivity: false,
	showSettings: false,
	// the current long-running activity: phase idle | running | done | error
	activity: { phase: "idle", pct: null, message: "", title: "Activity", output: null, action: null },
};
