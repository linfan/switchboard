import { BUILD_INFO, formatBuildTime } from "../buildInfo";
import { Modal } from "./Modal";

/**
 * Version/build provenance for the running client. The stamps come from Vite's
 * `define` at bundle time, so "Built" answers *which* build this window is
 * running — useful when several installs or a dev server are in play.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="About" onClose={onClose}>
      <div className="about">
        <div className="about__name">Switchboard</div>
        <table className="about__table">
          <tbody>
            <tr>
              <td className="about__label">Version</td>
              <td className="about__value">{BUILD_INFO.version}</td>
            </tr>
            <tr>
              <td className="about__label">Built</td>
              {/* Exact UTC instant on hover; the cell itself shows local time. */}
              <td className="about__value" title={BUILD_INFO.builtAt}>
                {formatBuildTime(BUILD_INFO.builtAt)}
              </td>
            </tr>
            <tr>
              <td className="about__label">Commit</td>
              <td className="about__value">{BUILD_INFO.commit}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
