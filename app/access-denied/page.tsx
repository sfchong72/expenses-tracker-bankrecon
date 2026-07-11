import Link from "next/link";

export default function AccessDeniedPage() {
  return (
    <main>
      <header>
        <div>
          <span>Access denied</span>
          <h1>You do not have permission to open this page.</h1>
        </div>
      </header>
      <section className="notice error">
        <p>Your account is active, but this area is restricted to an owner or assigned user role.</p>
      </section>
      <p>
        <Link href="/">Return to dashboard</Link>
      </p>
    </main>
  );
}
