export function Logo(): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 shadow-[0_0_24px_rgba(124,58,237,0.25)]">
        <div className="size-3.5 rounded-full border-[3px] border-white" />
        <div className="absolute bottom-1.5 right-1.5 size-1.5 rounded-full bg-white" />
      </div>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-white">OpticPR</span>
    </div>
  );
}
