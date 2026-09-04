# Reply to Matthew — Phantom Barriers & New Observations

> **Historical unsent draft.** This describes the abandoned RO-shifting and
> chain-hopper experiment. It is retained only as research provenance and must
> not be read as the current solution; see `SOLUTION.md` for the audited status.

---

**Subject:** Re: Observations on Maximal Non-Interleaving in Fugue

---

Hey Matthew,

Thanks a lot for looking into this — your explanation of Scenario 1 makes a lot of sense and really helped me understand why the reverse right-origin ordering is a necessary constraint. That said, I think there may be a gap in the paper between the *definition* of maximal non-interleaving and FugueMax itself. From my reading, the definition doesn't explicitly constrain the reverse ordering of right origins — the constraint seems to emerge from the algorithm rather than from the formal property. But I may well be misunderstanding something, and I'd welcome your thoughts on this.

In any case, given that reverse right-origin ordering is correct, Scenario 3 from my previous email becomes moot.

---

On Scenario 2 (phantom barriers), I've spent the better part of this past week working on a solution. My current approach consists of:

1. **Shifting right origins so they are never tombstones** — at insertion time, we skip deleted nodes when computing the right origin.
2. **Replicating the replacement right origin with delete messages** — when a node is deleted, the delete message carries the proposed new right origin (the next alive node to the right).
3. **Given a choice of multiple proposed right origins, choosing the leftmost one** — the intuition here comes from how Fugue's tree structure encodes time. The start and end of the document (root and null) sit at the extremes and represent the earliest point in time. Nodes inserted later appear closer to the interior. So the leftmost candidate right origin corresponds to the latest deletion in the chain, making it the correct one to pick.

However, there are still edge cases I haven't been able to resolve cleanly. Consider the scenario below, where the left origins of the inserted elements differ depending on whether the user first inserts `c` then deletes `b`, or first deletes `b` then inserts `c`. In both cases, the user intent is the same — inserting between `a` and `b`'s position — but the tree structure diverges:

![Scenario: different left origins for same user intent](Screenshot 2026-02-28 at 5.51.04 AM.png)

I've also found another scenario where it's possible for both forward and backward non-interleaving to be satisfied simultaneously, but FugueMax's ID ordering of elements with the same left and right origins may produce `bdac`. In the diagram below, `b`, `a`, and `c` are all concurrent inserts into an empty list with the same left origin (root) and the same right origin (null), and `d` is then inserted between `b` and `c` by a peer who saw only those two:

![Scenario: forward and backward non-interleaving both satisfiable](Screenshot 2026-02-28 at 5.55.31 AM.png)

You can find my reimplementation of FugueMax and the test scenarios under the `fugue-max-simple` and `fugue-interleave` folders at https://github.com/bxff/fugue.

I'd love to hear your thoughts on these edge cases, and whether you see a path toward a cleaner definition that handles tombstones more robustly.

Best regards,
Musaab Khan
