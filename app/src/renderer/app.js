const { useState, useEffect, useRef, createElement: h } = React;

const STATUS_LABEL = {
  pending: 'Queued',
  downloading: 'Downloading',
  transcribing: 'Transcribing',
  done: 'Done',
  failed: 'Failed',
};

function StatusBadge(status) {
  return h('span', { className: `badge badge-${status}` }, STATUS_LABEL[status] || status);
}

function App() {
  const [running, setRunning] = useState(false);
  const [counts, setCounts] = useState({ pending: 0, downloading: 0, transcribing: 0, done: 0, failed: 0, total: 0 });
  const [current, setCurrent] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [videos, setVideos] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [view, setView] = useState('queue'); // 'queue' | 'logs'
  const logRef = useRef(null);

  const refreshList = () => window.api.list().then(setVideos);

  const toggleSelected = (videoId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  };

  const allVisibleSelected = videos.length > 0 && videos.every((v) => selected.has(v.video_id));
  const toggleSelectAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(videos.map((v) => v.video_id)));
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Remove ${selected.size} video(s) from the queue? This only removes them from the list — any audio/transcript already saved on disk is kept.`)) {
      return;
    }
    const ids = Array.from(selected);
    await window.api.deleteVideos(ids);
    setVideos((prev) => prev.filter((v) => !selected.has(v.video_id)));
    setSelected(new Set());
    window.api.counts().then(setCounts);
  };

  const addFiles = async () => {
    const result = await window.api.addFiles();
    if (result.added > 0 || result.imported > 0) {
      await refreshList();
      window.api.counts().then(setCounts);
    }
  };

  useEffect(() => {
    window.api.counts().then(setCounts);
    refreshList();
    window.api.onLog((line) => {
      setLogLines((prev) => {
        const next = [...prev, line];
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    });
    window.api.onState((state) => {
      setRunning(state.running);
      setCounts(state.counts);
      if ('current' in state) setCurrent(state.current);
    });
    window.api.onItem((item) => {
      setVideos((prev) =>
        prev.map((v) =>
          v.video_id === item.video_id
            ? {
                ...v,
                status: item.status,
                error: item.error !== undefined ? item.error : v.error,
                transcript_txt_path:
                  item.transcript_txt_path !== undefined ? item.transcript_txt_path : v.transcript_txt_path,
              }
            : v,
        ),
      );
    });
  }, []);

  useEffect(() => {
    if (view === 'logs' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines, view]);

  const failedCount = counts.failed;

  return h('div', null,
    h('div', { className: 'row' },
      h('h2', { style: { flex: 1, margin: 0 } }, 'YouTube → Audio → Transcript Queue'),
      h('button', { className: view === 'queue' ? 'active' : '', onClick: () => setView('queue') }, 'Queue'),
      h('button', { className: view === 'logs' ? 'active' : '', onClick: () => setView('logs') }, 'Logs'),
    ),
    h('div', { className: 'row' },
      h('button', { onClick: () => window.api.start(), disabled: running }, 'Start / Resume'),
      h('button', { onClick: () => window.api.stop(), disabled: !running }, 'Pause after current'),
      h('button', { onClick: () => window.api.retryFailed(), disabled: running || failedCount === 0 },
        `Retry All Failed (${failedCount})`),
      h('button', { onClick: addFiles }, 'Add Files (.jsonl)'),
      h('button', { className: 'danger', onClick: deleteSelected, disabled: running || selected.size === 0 },
        `Remove Selected (${selected.size})`),
    ),
    h('div', { className: 'counts row' },
      h('span', null, `Total: ${counts.total}`),
      h('span', null, `Queued: ${counts.pending}`),
      h('span', null, `Downloading: ${counts.downloading}`),
      h('span', null, `Transcribing: ${counts.transcribing}`),
      h('span', { className: 'ok' }, `Done: ${counts.done}`),
      h('span', { className: 'bad' }, `Failed: ${counts.failed}`),
    ),
    current
      ? h('div', { className: 'current' }, `Current: ${current.title || current.video_id} — ${current.stage}`)
      : h('div', { className: 'current' }, running ? 'Working…' : 'Idle'),

    view === 'queue'
      ? h('div', { id: 'queue-list' },
          h('table', null,
            h('thead', null,
              h('tr', null,
                h('th', { className: 'ckcol' },
                  h('input', { type: 'checkbox', checked: allVisibleSelected, onChange: toggleSelectAll }),
                ),
                h('th', null, 'Title'), h('th', null, 'Status'), h('th', null, 'Reason'),
                h('th', null, 'Link'), h('th', null, ''),
              ),
            ),
            h('tbody', null,
              videos.map((v) => h('tr', { key: v.video_id, className: v.status === 'failed' ? 'row-failed' : '' },
                h('td', { className: 'ckcol' },
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(v.video_id),
                    onChange: () => toggleSelected(v.video_id),
                  }),
                ),
                h('td', {
                  className: v.status === 'done' ? 'vtitle vtitle-link' : 'vtitle',
                  title: v.error || (v.status === 'done' ? 'Open transcript' : ''),
                  onClick: v.status === 'done' ? () => window.api.openFile(v.transcript_txt_path) : undefined,
                }, v.title || v.video_id),
                h('td', null, StatusBadge(v.status)),
                h('td', { className: 'vreason', title: v.error || '' }, v.status === 'failed' ? (v.error || '') : ''),
                h('td', null,
                  v.url
                    ? h('a', {
                        href: '#',
                        className: 'link-btn',
                        onClick: (e) => { e.preventDefault(); window.api.openUrl(v.url); },
                      }, 'YouTube')
                    : null,
                ),
                h('td', null,
                  v.status === 'failed'
                    ? h('button', { className: 'small', onClick: () => window.api.retryOne(v.video_id), disabled: running },
                        'Retry')
                    : null,
                ),
              )),
            ),
          ),
        )
      : h('div', { id: 'log', ref: logRef }, logLines.join('\n')),
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
