import React, { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { IoColorPaletteOutline } from 'react-icons/io5';
import useTooltip from '../BrowserScreen/useTooltip';
import LiveryInstallOverlay from '../BrowserScreen/LiveryInstallOverlay';

/**
 * InstallPackTab — legacy realistic-pack download/install flow (moved from
 * BrowserScreen.jsx) with an explanatory panel: what it does, the install
 * target, and the one-click install button.
 */
export default function InstallPackTab() {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const rootPath = useAppStore(s => s.rootPath);
  const [liveryLoading, setLiveryLoading] = useState(false);
  const [liveryOverlayOpen, setLiveryOverlayOpen] = useState(false);
  const { bind, TooltipPortal } = useTooltip();

  const handleInstallLivery = () => {
    if (liveryLoading) return;
    setLiveryLoading(true);
    setLiveryOverlayOpen(true);
  };

  const handleLiveryDownloadComplete = async (downloadedPath) => {
    setLiveryOverlayOpen(false);
    try {
      const result = await electronAPI.installLivery(downloadedPath);
      const { showToast } = useAppStore.getState();
      if (result.success) {
        showToast(t('livery_installed'), 'success');
      } else {
        showToast(result.error === 'NO_GAME_ROOT' ? t('vr_no_game_root') : (result.error || t('livery_failed')), 'error');
      }
    } catch (err) {
      const { showToast } = useAppStore.getState();
      showToast(err.message, 'error');
    } finally {
      setLiveryLoading(false);
    }
  };

  const handleLiveryDownloadError = async () => {
    setLiveryOverlayOpen(false);
    setLiveryLoading(false);

    const dialogResult = await electronAPI.selectLiveryZip();
    if (dialogResult.canceled) return;

    setLiveryLoading(true);
    try {
      const result = await electronAPI.installLivery(dialogResult.filePath);
      const { showToast } = useAppStore.getState();
      if (result.success) {
        showToast(t('livery_installed'), 'success');
      } else {
        showToast(result.error === 'NO_GAME_ROOT' ? t('vr_no_game_root') : (result.error || t('livery_failed')), 'error');
      }
    } catch (err) {
      const { showToast } = useAppStore.getState();
      showToast(err.message, 'error');
    } finally {
      setLiveryLoading(false);
    }
  };

  return (
    <div>
      <h3 className="livery-section-title">{t('livery_tab_install')}</h3>
      <p className="livery-desc">{t('livery_install_desc')}</p>
      {rootPath && (
        <p className="livery-desc">
          {t('livery_install_target')}: <code>{rootPath}/Mods</code>
        </p>
      )}
      <div className="livery-form-row">
        <button className="btn-sm" {...bind(t('livery_tip_install'))} onClick={handleInstallLivery} disabled={liveryLoading}>
          <IoColorPaletteOutline size={14} className="btn-icon" />{t('browser_livery')}
        </button>
      </div>
      {liveryOverlayOpen && (
        <LiveryInstallOverlay
          onComplete={handleLiveryDownloadComplete}
          onError={handleLiveryDownloadError}
        />
      )}
      {TooltipPortal}
    </div>
  );
}
