import Link from "next/link";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Zoomo home">
      <iframe
        className="brand-animation"
        src="/zoomo-logo-animated.html"
        title=""
        aria-hidden="true"
        sandbox="allow-scripts"
        tabIndex={-1}
      />
      <span>zoomo</span>
    </Link>
  );
}
