# Objects team (Records objects layer), state at the stop

Branch work/objects (pushed). Items 10 to 13 and the follow-ons are in.

Done: conditional fields (visible_if, required_if), stored views on the type (read by the app, written into Twenty's own views), stage entry conditions and stage sets, all views per type with the title menu and Filtered row, base kit (no legal words) and law-firm library kit, base kit on every new Space, hidden bookkeeping types, one Task core type (owned_by "kernel" on status, stage, record; enforced in the gateway on the acting hop; a change cannot drop it), Contact time_zone (format "time_zone"), core Project client links to contact, duplicate-label refusal, board by any choice field, field icon/description/order in Twenty.

Open: (1) reviewer-5 holds on the Task type being unwired: platform-2 owns the wiring (kernel/tasks mirrors into the record) and has merged TASK into work/platform2; land TASK with that wiring or accept it ahead. (2) R5: many and inverse in the Kit SDK once windows' relations reach work/devbox. (3) Swap format "time_zone" to lib/time validZone when lib/time lands on devbox. (4) apps tsc typecheck was never run (no node_modules on the boxes). (5) Run the live Twenty views test again after any store.define change: stores/twenty/live/views.live.test.js via conformance-live.sh with KEEP=1.

Next step: merge origin/work/devbox into work/objects, rerun the records, kits, gateway, stores/twenty and views suites on a test box, send the sha to reviewer-5.
