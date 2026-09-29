// The Duel Lens mark from the design study (a card under a magnifier), inline so it
// needs no network request and works under any page CSP.
export function LensIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3.2" y="2.8" width="10.5" height="15" rx="1.6" transform="rotate(-8 8.4 10.3)" />
      <circle cx="15.2" cy="14.2" r="4.6" fill="currentColor" fill-opacity=".14" />
      <path d="M18.6 17.6 21.4 20.4" />
    </svg>
  );
}
