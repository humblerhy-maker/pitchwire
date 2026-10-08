/** Trimmed from a real scoreboard response captured 2026-10-06. Not a simulation. */
export const ESPN_SAMPLE = {
  events: [
    {
      id: "401917360",
      date: "2026-10-06T16:00Z",
      name: "Nigeria at Russia",
      season: { slug: "2026-international-friendly" },
      competitions: [
        {
          id: "401917360",
          altGameNote: "Men's International Friendly",
          status: {
            displayClock: "31'",
            period: 1,
            type: { name: "STATUS_IN_PROGRESS", state: "in", detail: "31'" },
          },
          competitors: [
            { homeAway: "home", score: "1", team: { id: "454", displayName: "Russia" } },
            { homeAway: "away", score: "1", team: { id: "657", displayName: "Nigeria" } },
          ],
          details: [
            {
              type: { id: "70", text: "Goal" },
              clock: { value: 561, displayValue: "10'" },
              team: { id: "657" },
              scoringPlay: true,
              redCard: false,
              yellowCard: false,
              penaltyKick: false,
              ownGoal: false,
              athletesInvolved: [{ displayName: "Kelechi Iheanacho" }],
            },
            {
              type: { id: "70", text: "Goal" },
              clock: { value: 1756, displayValue: "30'" },
              team: { id: "454" },
              scoringPlay: true,
              redCard: false,
              yellowCard: false,
              penaltyKick: false,
              ownGoal: false,
              athletesInvolved: [{ displayName: "Lechii Sadulaev" }],
            },
          ],
        },
      ],
    },
  ],
};
