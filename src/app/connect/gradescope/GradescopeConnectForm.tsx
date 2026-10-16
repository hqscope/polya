"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { loginPathFor } from "@/lib/auth/next-path";
import {
  GRADESCOPE_CONNECT_PATH,
  connectErrorMessage,
  connectedSummary,
  statusSummary,
  type ConnectErrorCode,
  type ConnectMode,
  type ConnectState,
  type GradescopeStatus,
} from "@/lib/gradescope-connect";

import { connectGradescope } from "./actions";

const INITIAL_STATE: ConnectState = { step: "idle" };

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-[9px] text-[13px] shadow-card outline-none placeholder:text-ink3 focus:border-accent";

const STATUS_DOT: Record<GradescopeStatus, string> = {
  connected: "bg-accent",
  broken: "bg-amber",
  not_connected: "bg-ink3",
  unknown: "bg-ink3",
};

const TEXT_LINK = "underline underline-offset-2 hover:text-ink";

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-line bg-rail px-1 py-px font-mono text-[11.5px] text-ink">
      {children}
    </kbd>
  );
}

// The default path: school sign-in (like CalNet) has no Gradescope password,
// so the student copies the cookie from a browser that's signed in.
function CookieFields() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px]">Paste your Gradescope cookie</h2>
        <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">
          For accounts you sign in to through your school, like CalNet. Do
          this on a computer.
        </p>
      </div>
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-[18px] text-[12.5px] leading-[1.7] text-ink2">
        <li>
          Go to{" "}
          <a
            href="https://www.gradescope.com"
            target="_blank"
            rel="noopener noreferrer"
            className={TEXT_LINK}
          >
            gradescope.com
          </a>{" "}
          and sign in with <strong className="text-ink">School Credentials</strong>.
        </li>
        <li>
          Open developer tools with <Key>⌘⌥I</Key> (<Key>Ctrl+Shift+I</Key> on
          Windows), then choose the <strong className="text-ink">Network</strong> tab.
        </li>
        <li>Reload the page.</li>
        <li>Click the first request in the list.</li>
        <li>
          Under <strong className="text-ink">Request Headers</strong>, right-click{" "}
          <strong className="text-ink">Cookie</strong> and choose{" "}
          <strong className="text-ink">Copy value</strong>.
        </li>
        <li>Paste it here.</li>
      </ol>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="gradescope-cookie" className="text-[12.5px] font-semibold">
          Gradescope cookie
        </label>
        {/* Uncontrolled, so React clears it after every submit. Masked like a
            password; the data attributes keep password managers out of it. */}
        <textarea
          id="gradescope-cookie"
          name="cookie"
          required
          rows={3}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          placeholder="Paste the Cookie value"
          className={`${FIELD} resize-none font-mono break-all [-webkit-text-security:disc] placeholder:font-body`}
        />
        <p className="m-0 text-[12px] leading-[1.6] text-ink3">
          Treat this like a password. Only paste it here, on askpolya.com.
        </p>
      </div>
    </>
  );
}

// For accounts with their own Gradescope password. The email is controlled so
// it survives the form reset after a failed try; the password isn't.
function PasswordFields({
  email,
  onEmailChange,
}: {
  email: string;
  onEmailChange: (email: string) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px]">Use your Gradescope password</h2>
        <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">
          This works only if you set a password on Gradescope itself. If you
          sign in through your school, use the cookie steps instead.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="gradescope-email" className="text-[12.5px] font-semibold">
          Gradescope email
        </label>
        <input
          id="gradescope-email"
          name="email"
          type="email"
          required
          autoComplete="off"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="gradescope-password" className="text-[12.5px] font-semibold">
          Gradescope password
        </label>
        <input
          id="gradescope-password"
          name="password"
          type="password"
          required
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          className={FIELD}
        />
      </div>
    </>
  );
}

function ErrorNote({
  code,
  onUseCookie,
}: {
  code: ConnectErrorCode;
  onUseCookie: () => void;
}) {
  return (
    <p
      role="alert"
      className="m-0 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] leading-[1.6] text-amber"
    >
      {connectErrorMessage(code)}
      {code === "sso_required" ? (
        <>
          {" "}
          <button type="button" onClick={onUseCookie} className={`cursor-pointer ${TEXT_LINK}`}>
            Show the cookie steps
          </button>
        </>
      ) : null}
      {code === "signed_out" ? (
        <>
          {" "}
          <a href={loginPathFor(GRADESCOPE_CONNECT_PATH)} className={TEXT_LINK}>
            Sign in again
          </a>{" "}
          to reconnect Gradescope.
        </>
      ) : null}
    </p>
  );
}

function Connected({ courses, courseNames }: { courses: number; courseNames: string[] }) {
  return (
    <>
      <h1 className="text-[20px]">Gradescope is connected</h1>
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">{connectedSummary(courses)}</p>
      {courseNames.length > 0 ? (
        <ul className="m-0 flex list-disc flex-col gap-1 rounded-lg border border-line-soft bg-rail py-2.5 pr-3.5 pl-[30px] text-[12.5px] leading-[1.6] text-ink">
          {courseNames.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-[13px] leading-[1.65] text-ink2">
        You can go back to your texts with Polya now.
      </p>
      <Link href="/app" className="button-secondary mt-2 self-start">
        Open Polya
      </Link>
    </>
  );
}

export default function GradescopeConnectForm({
  email,
  status,
}: {
  email: string;
  status: GradescopeStatus;
}) {
  const [state, formAction, pending] = useActionState(connectGradescope, INITIAL_STATE);
  const [mode, setMode] = useState<ConnectMode>("cookie");
  const [gradescopeEmail, setGradescopeEmail] = useState("");
  // An error belongs to the path it came from: switching paths hides it until
  // the next submit.
  const [dismissed, setDismissed] = useState<ConnectState | null>(null);

  if (state.step === "connected") {
    return <Connected courses={state.courses} courseNames={state.courseNames} />;
  }

  function switchMode(next: ConnectMode) {
    setMode(next);
    setDismissed(state);
  }

  const error = state.step === "error" && state !== dismissed ? state.code : null;
  const summary = statusSummary(status);

  return (
    <>
      <h1 className="text-[20px]">Reconnect Gradescope</h1>
      <div className="flex gap-2.5 rounded-lg border border-line-soft bg-rail px-3.5 py-3">
        <span
          aria-hidden="true"
          className={`mt-[6px] size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
        />
        <div className="flex flex-col gap-0.5">
          <p className="m-0 text-[13px] font-semibold text-ink">{summary.title}</p>
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink2">{summary.body}</p>
        </div>
      </div>
      <p className="m-0 text-[12.5px] text-ink3">Signed in to Polya as {email}.</p>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="mode" value={mode} />
        {mode === "cookie" ? (
          <CookieFields />
        ) : (
          <PasswordFields email={gradescopeEmail} onEmailChange={setGradescopeEmail} />
        )}

        {error ? <ErrorNote code={error} onUseCookie={() => switchMode("cookie")} /> : null}

        <button
          type="submit"
          disabled={pending}
          className="button-primary h-9 w-full text-[13px] disabled:opacity-60"
        >
          {pending ? "Connecting…" : "Connect Gradescope"}
        </button>
      </form>

      <button
        type="button"
        disabled={pending}
        onClick={() => switchMode(mode === "cookie" ? "password" : "cookie")}
        className={`cursor-pointer self-start text-[12.5px] text-ink2 disabled:opacity-60 ${TEXT_LINK}`}
      >
        {mode === "cookie" ? "Use a Gradescope password instead" : "Use the cookie steps instead"}
      </button>

      <form action="/auth/signout" method="post">
        <p className="m-0 text-[12px] text-ink3">
          Not you?{" "}
          <button
            type="submit"
            className="cursor-pointer text-ink3 underline underline-offset-2 hover:text-ink"
          >
            Sign out
          </button>
          , then open this page again.
        </p>
      </form>
    </>
  );
}
