// Ticket 048 FR-7: free government options, shown on every non-urgent check-in result. Static content: an admin checks
// the details and updates `FREE_SERVICES_LAST_CHECKED` (docs/screen-recommendations.md). Names and addresses are proper
// nouns (English); the descriptions are translated (`screen.free.*`).
export type FreeService = {
  /** Message key under `screen.free.services.<key>` (name line and description). */
  key: "deic" | "niepid";
  name: string;
  /** null = no single address (per district). */
  address: string | null;
  /** Display form, plus the `tel:` value. null = ask at the district hospital. */
  phone: { display: string; tel: string } | null;
  tollFree: { display: string; tel: string } | null;
  url: string | null;
};

/** Date (YYYY-MM-DD) the details below were last checked against the official source. */
export const FREE_SERVICES_LAST_CHECKED = "2026-11-13";

export const FREE_SERVICES: readonly FreeService[] = [
  {
    // RBSK District Early Intervention Centres: one per district hospital, free for children up to 6. Per-district
    // details (Hyderabad, Rangareddy, Medchal) are an open question in specs/tickets/048-checkin-up-to-8/rd.md.
    key: "deic",
    name: "District Early Intervention Centre (DEIC)",
    address: null,
    phone: null,
    tollFree: null,
    url: null,
  },
  {
    // Checked on niepid.nic.in on 2026-11-13 (contact block of the home page).
    key: "niepid",
    name: "NIEPID (National Institute for the Empowerment of Persons with Intellectual Disabilities)",
    address: "Manovikas Nagar, Bowenpally, Secunderabad, Telangana 500009",
    phone: { display: "+91 40 2775 1741", tel: "+914027751741" },
    tollFree: { display: "1800 572 6422", tel: "18005726422" },
    url: "https://niepid.nic.in/",
  },
];
