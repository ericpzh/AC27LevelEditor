import React, { useMemo, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { getCommandsForAircraft, getCommandChildren } from './commandTree';

/**
 * Command bar displayed above the bottom status bar when a strip is selected.
 * Shows callsign + pipe-separated action buttons filtered by aircraft state.
 * Supports multi-stage sub-menus via commandPath navigation stack.
 *
 * Props:
 *   aircraft       — selected UDP aircraft object (null → hidden)
 *   commandPath    — string[] sub-menu navigation stack
 *   onCommandAction(cmd) — called with the command node on click
 *   onBack()       — back button callback (pop path)
 *   witchMode      — boolean; returns null when true
 */
export default function FlightStripCommandBar({
  aircraft,
  commandPath,
  onCommandAction,
  onBack,
  witchMode,
}) {
  const { t } = useTranslation();

  // Compute current menu items based on aircraft state and path depth
  const menuItems = useMemo(() => {
    if (!aircraft) return [];
    const rootCommands = getCommandsForAircraft(aircraft);
    if (commandPath.length === 0) return rootCommands;

    // Walk into the branch specified by commandPath
    let current = rootCommands;
    for (const pathId of commandPath) {
      const found = current.find(c => c.id === pathId);
      if (!found) return [];
      const children = getCommandChildren(aircraft, found);
      if (!children) return [];
      current = children;
    }
    return current;
  }, [aircraft, commandPath]);

  const inSubMenu = commandPath.length > 0;

  const handleClick = useCallback((cmd) => {
    onCommandAction(cmd);
  }, [onCommandAction]);

  // Hidden in witch mode or when no aircraft selected
  if (!aircraft || witchMode) return null;

  const visible = !!aircraft;

  return (
    <div className={'flight-strips-command-bar' + (visible ? ' cmd-bar-visible' : '')}>
      <span className="cmd-bar-callsign">{aircraft.callSign}</span>
      <span className="cmd-bar-sep">|</span>
      {inSubMenu && (
        <>
          <button className="cmd-bar-btn cmd-bar-back" onClick={onBack} title={t('cmd_back')}>
            {'←'}
          </button>
          <span className="cmd-bar-sep">|</span>
        </>
      )}
      {menuItems.map((cmd, i) => {
        const label = cmd.labelKey ? t(cmd.labelKey) : (cmd.label || cmd.id);
        return (
          <React.Fragment key={cmd.id}>
            {i > 0 && <span className="cmd-bar-sep">|</span>}
            <button
              className="cmd-bar-btn"
              onClick={() => handleClick(cmd)}
            >
              {label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
