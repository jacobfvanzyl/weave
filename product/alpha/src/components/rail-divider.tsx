export function RailDivider({ slot }: { slot: string }) {
  return (
    <span
      data-slot={slot}
      aria-hidden='true'
      className='mx-1 my-1 w-px self-stretch shrink-0 bg-border'
    />
  );
}
