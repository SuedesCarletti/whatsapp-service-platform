import React from 'react';
import {
  BsFileEarmarkPdfFill, BsFileEarmarkWordFill, BsFileEarmarkExcelFill, BsFileEarmarkPptFill,
  BsFileEarmarkZipFill, BsFileEarmarkMusicFill, BsFileEarmarkPlayFill, BsFileEarmarkTextFill,
  BsFileEarmarkFill,
} from 'react-icons/bs';

// Preview de documento estilo WhatsApp (ícone por tipo + nome + tamanho) —
// compartilhado entre ChatArea.js e InternalChatArea.js pra não divergir de
// novo (o chat de equipe ficou preso num ícone genérico único por um tempo
// enquanto o chat de cliente já tinha essa variação por extensão).
export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileTypeIcon(filename, mimeType) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  const mime = (mimeType || '').toLowerCase();
  if (ext === 'pdf' || mime.includes('pdf')) return <BsFileEarmarkPdfFill color="#e64949" size={40} />;
  if (['doc', 'docx', 'odt'].includes(ext) || mime.includes('word')) return <BsFileEarmarkWordFill color="#2b579a" size={40} />;
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext) || mime.includes('sheet') || mime.includes('excel')) return <BsFileEarmarkExcelFill color="#217346" size={40} />;
  if (['ppt', 'pptx', 'odp'].includes(ext) || mime.includes('presentation') || mime.includes('powerpoint')) return <BsFileEarmarkPptFill color="#d24726" size={40} />;
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) || mime.includes('zip') || mime.includes('compressed')) return <BsFileEarmarkZipFill color="#8a6d3b" size={40} />;
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(ext) || mime.startsWith('audio/')) return <BsFileEarmarkMusicFill color="#8e44ad" size={40} />;
  if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext) || mime.startsWith('video/')) return <BsFileEarmarkPlayFill color="#2980b9" size={40} />;
  if (['txt', 'rtf'].includes(ext) || mime.startsWith('text/')) return <BsFileEarmarkTextFill color="#7f8c8d" size={40} />;
  return <BsFileEarmarkFill color="#7f8c8d" size={40} />;
}
