import { InfoCard } from '../components/Previewer';
import type { PreviewProps } from './registry';

export default function UnknownView({ file, mount }: PreviewProps) {
  return <InfoCard file={file} mount={mount} note="No preview available for this file type." />;
}
