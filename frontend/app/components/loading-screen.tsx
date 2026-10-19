type LoadingScreenProps = { message: string };

export function LoadingScreen({ message }: LoadingScreenProps) {
  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-label={message}>
      <div className="loading-card">
        <iframe
          className="loading-animation"
          src="/zoomo-logo-animated.html?mode=loader"
          title=""
          aria-hidden="true"
          sandbox="allow-scripts"
          tabIndex={-1}
        />
        <strong>{message}</strong>
        <p>Getting your Zoomo account ready</p>
        <span className="loading-progress" aria-hidden="true"><i /></span>
      </div>
    </div>
  );
}
