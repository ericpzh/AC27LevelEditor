import React, { useEffect, useState } from 'react';
import { BsWindowX } from 'react-icons/bs';
import { useTranslation } from '../../hooks/useTranslation';
import './LiveSessionOverlay.css';

/**
 * Full-window blur notice shown while no live UDP session is detected.
 * `visible` should be true only when the UDP listener reports disconnected.
 * Clicking outside the notice dismisses it until the next disconnect.
 */
export default function LiveSessionOverlay({ visible }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  // Re-arm the notice whenever a fresh disconnect transition happens.
  useEffect(() => {
    if (visible) setDismissed(false);
  }, [visible]);

  if (!visible || dismissed) return null;
  return (
    <div className="live-session-overlay" onClick={() => setDismissed(true)}>
      <div className="live-session-overlay-text" onClick={(e) => e.stopPropagation()}>
        <BsWindowX className="live-session-overlay-icon" size={28} />
        <span>{t('map_no_session')}</span>
      </div>
    </div>
  );
}
