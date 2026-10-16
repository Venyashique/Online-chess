export function ChessMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M23 12h18l-2 10 8 14-8 8v6H23v-6l-8-8 10-14-2-10Z"
        fill="currentColor"
      />
      <path
        d="M28 8h8M32 4v8M21 51h22l5 7H16l5-7Z"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M25 26h14" stroke="var(--piece-line, #f7f6f2)" strokeWidth="2" />
    </svg>
  );
}
