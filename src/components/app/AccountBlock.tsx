// Name, email and Sign out. Shown at the foot of the desktop sidebar and inside
// the phone-width menu.
export default function AccountBlock({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  return (
    <div className="flex flex-col border-t border-line px-2.5 pt-3">
      <p className="m-0 truncate text-[12.5px] font-semibold">{displayName}</p>
      <p className="m-0 truncate text-[11.5px] text-ink3">{email}</p>
      <form action="/auth/signout" method="post" className="mt-1">
        <button
          type="submit"
          className="cursor-pointer py-1 text-[12px] text-ink3 hover:text-ink"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
