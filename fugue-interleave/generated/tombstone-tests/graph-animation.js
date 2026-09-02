(() => {
  'use strict';
  const COLORS = {
    grey: '#3c3c3c', edge: '#484848', text: '#d7d7da', dim: '#8d8d92',
    red: '#f14c4c', blue: '#3794ff', green: '#35c47a', orange: '#ffad45',
    shared: '#f586f0', white: '#ffffff', yellow: '#ffd83d', pass: '#35c47a', fail: '#ff5b52'
  };
  const BRANCH_COLORS = [COLORS.red, COLORS.blue, COLORS.green, COLORS.orange];
  const tau = Math.PI * 2;
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const bare = token => token.endsWith('†') ? token.slice(0, -1) : token;

  function setup(canvas, world, worldIndex) {
    const ctx = canvas.getContext('2d');
    let started = performance.now();
    let visible = true;
    let frame = null;

    const restart = () => { started = performance.now(); schedule(); };
    canvas.addEventListener('click', restart);

    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) schedule();
      else if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    }, { rootMargin: '100px' });
    observer.observe(canvas);

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.max(320, Math.floor(canvas.getBoundingClientRect().width));
      canvas.style.height = size + 'px';
      const pixelSize = Math.round(size * dpr);
      if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
        canvas.width = pixelSize;
        canvas.height = pixelSize;
      }
    }

    function schedule() {
      if (!visible || frame !== null) return;
      frame = requestAnimationFrame(now => { frame = null; draw(now); schedule(); });
    }

    function line(x1, y1, x2, y2, color, width, progress = 1, reverse = false) {
      let ax = x1, ay = y1, bx = x2, by = y2;
      if (reverse) { ax = x2; ay = y2; bx = x1; by = y1; }
      const ex = ax + (bx - ax) * progress;
      const ey = ay + (by - ay) * progress;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey);
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
    }

    function circle(x, y, radius, color, scale = 1) {
      ctx.beginPath(); ctx.arc(x, y, radius * scale, 0, tau); ctx.fillStyle = color; ctx.fill();
    }

    function centerText(text, x, y, size, color, weight = 650) {
      ctx.font = weight + ' ' + size + 'px Avenir Next, Avenir, Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, x, y);
    }

    function wrappedText(text, x, y, maxWidth, size, color, lineHeight) {
      ctx.font = '650 ' + size + 'px Avenir Next, Avenir, Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = color;
      const words = text.split(/\s+/); const lines = []; let lineText = '';
      for (const word of words) {
        const next = lineText ? lineText + ' ' + word : word;
        if (lineText && ctx.measureText(next).width > maxWidth) { lines.push(lineText); lineText = word; }
        else lineText = next;
      }
      if (lineText) lines.push(lineText);
      lines.slice(0, 3).forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight));
    }

    function tokenString(tokens, x, y, size, color, highlight) {
      const gap = size * 0.74; const start = x - (tokens.length - 1) * gap / 2;
      if (highlight && highlight.end > highlight.start) {
        ctx.fillStyle = COLORS.yellow;
        ctx.fillRect(start + highlight.start * gap - gap * .48, y - size * .58,
          (highlight.end - highlight.start) * gap, size * .92);
      }
      tokens.forEach((token, index) => {
        const tx = start + index * gap; const dead = token.endsWith('†');
        centerText(bare(token), tx, y, size, dead ? '#888b91' : color, 700);
        if (dead) {
          line(tx - gap * .37, y, tx + gap * .37, y, '#999ca2', Math.max(.0014, size * .065));
          centerText('†', tx + gap * .42, y - size * .38, size * .42, '#999ca2', 600);
        }
      });
    }

    function draw(now) {
      resize();
      // Clear in backing-store coordinates before restoring the normalized
      // coordinate system.  This avoids stale pixels when an iframe is first
      // laid out at its intrinsic 300x150 canvas size and then becomes visible.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(canvas.width, 0, 0, canvas.height, 0, 0);

      const branchCount = world.branches.length;
      const source = world.source.length ? world.source : ['∅'];
      const sourceY = .15, branchY = .48, mergeY = .76;
      const sourceSpread = Math.min(.72, Math.max(.2, source.length * .15));
      const branchSpread = branchCount === 1 ? 0 : Math.min(.74, Math.max(.42, branchCount * .23));
      const sourcePositions = new Map();
      const sourcePoints = source.map((token, index) => {
        const x = source.length === 1 ? .5 : .5 - sourceSpread / 2 + index * sourceSpread / (source.length - 1);
        sourcePositions.set(bare(token), { x, y: sourceY, token, claims: [] }); return { x, y: sourceY, token, claims: [] };
      });
      const branchPoints = world.branches.map((branch, index) => ({
        x: branchCount === 1 ? .5 : .5 - branchSpread / 2 + index * branchSpread / (branchCount - 1),
        y: branchY, branch, index,
      }));

      const perBranch = 900, begin = 650, spread = 620;
      const mergeStart = begin + branchCount * perBranch + 350;
      const mergeDuration = 650, hold = 1900;
      const cycle = mergeStart + mergeDuration + hold;
      const t = (now - started) % cycle;
      const progress = branchPoints.map((_, index) => clamp((t - begin - index * perBranch) / spread));
      const mergeProgress = clamp((t - mergeStart) / mergeDuration);

      // Muted history first, exactly like the meeting-118 animator.
      branchPoints.forEach(point => {
        const from = point.branch.from.length ? point.branch.from : [source[0]];
        from.forEach(token => {
          const sourcePoint = sourcePositions.get(bare(token)) || sourcePoints[0];
          line(sourcePoint.x, sourcePoint.y, point.x, point.y, COLORS.edge, .0045);
          sourcePoint.claims.push(point.index);
        });
        line(point.x, point.y, .5, mergeY, COLORS.edge, .0045);
      });

      // Propagate each peer color backward through its ancestry.
      branchPoints.forEach(point => {
        const p = progress[point.index]; if (p <= 0) return;
        const color = BRANCH_COLORS[point.index % BRANCH_COLORS.length];
        const from = point.branch.from.length ? point.branch.from : [source[0]];
        from.forEach(token => {
          const sourcePoint = sourcePositions.get(bare(token)) || sourcePoints[0];
          line(sourcePoint.x, sourcePoint.y, point.x, point.y, color, .0055, p, true);
        });
      });

      // Shared source nodes become magenta once multiple highlighted branches reach them.
      sourcePoints.forEach(point => {
        const active = point.claims.filter(index => progress[index] >= 1);
        const color = active.length > 1 ? COLORS.shared
          : active.length === 1 ? BRANCH_COLORS[active[0] % BRANCH_COLORS.length]
          : COLORS.grey;
        circle(point.x, point.y, .024, color);
        tokenString([point.token], point.x, point.y - .052, .031, COLORS.text, null);
      });

      branchPoints.forEach(point => {
        const p = progress[point.index]; const color = BRANCH_COLORS[point.index % BRANCH_COLORS.length];
        const pop = p > 0 && p < 1 ? 1 + (1 - p) * .25 * Math.sin(Math.sqrt(p) * tau) : 1;
        circle(point.x, point.y, .025, p > 0 ? color : COLORS.grey, pop);
        tokenString(point.branch.view, point.x, point.y + .065, .033, COLORS.text, null);
        wrappedText(point.branch.origin, point.x, point.y + .105, branchCount > 2 ? .24 : .32, .017, COLORS.dim, .021);
      });

      if (mergeProgress > 0) {
        branchPoints.forEach(point => line(point.x, point.y, .5, mergeY,
          BRANCH_COLORS[point.index % BRANCH_COLORS.length], .006, mergeProgress));
      }
      const mergePop = mergeProgress > 0 && mergeProgress < 1
        ? 1 + (1 - mergeProgress) * .35 * Math.sin(Math.sqrt(mergeProgress) * tau) : 1;
      circle(.5, mergeY, .029, mergeProgress >= 1 ? COLORS.white : COLORS.grey, mergePop);
      centerText('MERGE', .5, mergeY - .058, .018, COLORS.dim, 800);

      world.results.forEach((result, index) => {
        const y = mergeY + .075 + index * .085;
        const status = result.status || (result.pass ? 'PASS' : 'FAIL');
        const statusColor = /UNVERIFIED/.test(status) ? COLORS.dim
          : /PROPOSAL|ERA/.test(status) ? '#d39b2a'
          : /DIFFERS|FORWARD NI|PUBLISHED/.test(status) ? '#4f9cf9'
          : result.pass ? COLORS.pass : COLORS.fail;
        centerText(result.label + ' · ' + status, .5, y - .026, status.length > 9 ? .0135 : .016, statusColor, 800);
        tokenString([...result.value], .5, y + .012, .038, COLORS.white,
          mergeProgress >= 1 ? result.highlight : null);
      });
    }

    schedule();
    return () => {
      visible = false;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
  }

  let activeCleanups = [];
  window.renderGraphCase = (root = document, graphCase = window.GRAPH_CASE) => {
    activeCleanups.forEach(cleanup => cleanup());
    activeCleanups = [];
    if (!graphCase) return;
    root.querySelectorAll('canvas[data-world]').forEach(canvas => {
      const index = Number(canvas.dataset.world);
      activeCleanups.push(setup(canvas, graphCase.worlds[index], index));
    });
  };
  if (window.GRAPH_CASE) window.renderGraphCase(document, window.GRAPH_CASE);
})();
