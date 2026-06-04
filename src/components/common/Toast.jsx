import React from 'react';
import { useAppStore } from '../../store/appStore';

export default function Toast() {
  const { message, type } = useAppStore(s => s.toast);
  return <div id="toast" className={type + (message ? ' show' : '')}>{message}</div>;
}
