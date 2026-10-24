// Landing-only, one-shot product demo. The complete contract remains visible in
// the HTML transcript; this controller adds progressive visual state, not facts.
(function () {
  var root = document.querySelector('[data-demo]');
  if (!root) return;

  var steps = [
    {
      label: '01 · publish',
      caption: 'The publisher sends order.created to the implicit events topic.',
      duration: 1000,
      hot: ['producer'], edges: ['publish'],
      auditState: 'waiting for copy', fulfillmentState: 'waiting for copy',
      auditAction: 'waiting', fulfillmentAction: 'waiting'
    },
    {
      label: '02 · route',
      caption: 'The topic stores nothing. Both subscription filters match this message.',
      duration: 1100,
      hot: ['topic'], edges: ['publish', 'fanout'],
      auditState: 'filter matched', fulfillmentState: 'filter matched',
      auditAction: 'waiting', fulfillmentAction: 'waiting'
    },
    {
      label: '03 · copy',
      caption: 'Each subscription gets an independent backing-queue copy: the message ID matches, the sequence number does not.',
      duration: 1200,
      hot: ['audit-queue', 'fulfillment-queue'], edges: ['fanout'],
      auditState: 'active · seq 1041', fulfillmentState: 'active · seq 1042',
      auditAction: 'waiting', fulfillmentAction: 'waiting'
    },
    {
      label: '04 · claim',
      caption: 'Each Receive moves active → locked and increments delivery_count to 1.',
      duration: 1300,
      hot: ['audit-queue', 'fulfillment-queue', 'audit-consumer', 'fulfillment-consumer'],
      edges: ['audit-claim', 'fulfillment-claim'],
      auditState: 'locked · delivery 1', fulfillmentState: 'locked · delivery 1',
      auditAction: 'processing', fulfillmentAction: 'processing'
    },
    {
      label: '05 · settle differently',
      caption: 'Audit removes only its message copy; the subscription remains. Below the delivery limit, Fulfillment abandons with delay: locked → scheduled, with no count increment.',
      duration: 1600,
      hot: [], edges: [], success: ['audit-queue', 'audit-consumer'], warn: ['fulfillment-queue', 'fulfillment-consumer'],
      auditState: 'copy removed · queue remains', fulfillmentState: 'scheduled · delivery 1',
      auditAction: 'complete ✓', fulfillmentAction: 'abandon + delay'
    },
    {
      label: '06 · due',
      caption: 'The scheduler returns the delayed fulfillment copy to active. Its delivery count remains 1.',
      duration: 1100,
      hot: ['fulfillment-queue'], edges: [], success: ['audit-queue', 'audit-consumer'],
      auditState: 'copy removed · queue remains', fulfillmentState: 'active · delivery 1',
      auditAction: 'complete ✓', fulfillmentAction: 'ready to retry'
    },
    {
      label: '07 · retry',
      caption: 'The next Receive locks the fulfillment copy and increments delivery_count to 2.',
      duration: 1200,
      hot: ['fulfillment-queue', 'fulfillment-consumer'], edges: ['fulfillment-claim'], success: ['audit-queue', 'audit-consumer'],
      auditState: 'copy removed · queue remains', fulfillmentState: 'locked · delivery 2',
      auditAction: 'complete ✓', fulfillmentAction: 'processing retry'
    },
    {
      label: '08 · complete',
      caption: 'The retry removes that message copy too; both subscriptions remain. Delivery is at-least-once, so handlers must remain idempotent.',
      duration: 0,
      hot: [], edges: [], success: ['audit-queue', 'audit-consumer', 'fulfillment-queue', 'fulfillment-consumer'],
      auditState: 'copy removed · queue remains', fulfillmentState: 'copy removed · queue remains',
      auditAction: 'complete ✓', fulfillmentAction: 'complete ✓'
    }
  ];

  var toggle = root.querySelector('[data-demo-toggle]');
  var replay = root.querySelector('[data-demo-replay]');
  var progress = root.querySelector('[data-demo-progress]');
  var label = root.querySelector('[data-demo-step-label]');
  var caption = root.querySelector('[data-demo-caption]');
  var transcript = Array.from(root.querySelectorAll('[data-demo-step]'));
  var nodes = Array.from(root.querySelectorAll('[data-demo-node]'));
  var edges = Array.from(root.querySelectorAll('[data-demo-edge]'));
  var values = {};
  root.querySelectorAll('[data-demo-value]').forEach(function (element) {
    values[element.dataset.demoValue] = element;
  });

  var current = 0;
  var timer = 0;
  var playing = false;
  var started = false;
  var complete = false;
  var inView = false;
  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduced = Boolean(motionQuery && motionQuery.matches);
  root.dataset.visible = 'false';

  function names(list) {
    return new Set(list || []);
  }

  function render(index) {
    current = index;
    var step = steps[index];
    var hot = names(step.hot);
    var success = names(step.success);
    var warn = names(step.warn);
    var activeEdges = names(step.edges);

    root.dataset.step = String(index);
    label.textContent = step.label;
    caption.textContent = step.caption;
    progress.textContent = 'step ' + (index + 1) + ' / ' + steps.length;
    values['audit-state'].textContent = step.auditState;
    values['fulfillment-state'].textContent = step.fulfillmentState;
    values['audit-action'].textContent = step.auditAction;
    values['fulfillment-action'].textContent = step.fulfillmentAction;

    nodes.forEach(function (node) {
      var name = node.dataset.demoNode;
      node.classList.toggle('is-hot', hot.has(name));
      node.classList.toggle('is-success', success.has(name));
      node.classList.toggle('is-warn', warn.has(name));
    });
    edges.forEach(function (edge) {
      edge.classList.toggle('is-hot', activeEdges.has(edge.dataset.demoEdge));
    });
    transcript.forEach(function (item, itemIndex) {
      item.classList.toggle('is-current', itemIndex === index);
      item.classList.toggle('is-complete', itemIndex < index || index === steps.length - 1);
      if (itemIndex === index) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function updateControls() {
    root.dataset.playing = String(playing);
    toggle.disabled = reduced;
    replay.disabled = reduced;
    if (reduced) {
      toggle.textContent = 'motion reduced';
    } else if (playing) {
      toggle.textContent = 'pause animation';
    } else if (complete) {
      toggle.textContent = 'play again';
    } else if (started) {
      toggle.textContent = 'resume animation';
    } else {
      toggle.textContent = 'play animation';
    }
  }

  function clearTimer() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  }

  function schedule() {
    clearTimer();
    if (!playing || !inView || document.hidden || current >= steps.length - 1) return;
    timer = window.setTimeout(function () {
      render(current + 1);
      if (current >= steps.length - 1) {
        playing = false;
        complete = true;
        updateControls();
        return;
      }
      schedule();
    }, steps[current].duration);
  }

  function play(explicit) {
    if (reduced) return;
    // A user who can activate this visible control must never be blocked by an
    // observer threshold that a short viewport cannot satisfy.
    if (explicit) {
      inView = true;
      root.dataset.visible = String(!document.hidden);
    }
    if (complete) {
      complete = false;
      render(0);
    }
    started = true;
    playing = true;
    updateControls();
    schedule();
  }

  function pause() {
    playing = false;
    clearTimer();
    updateControls();
  }

  function restart() {
    clearTimer();
    complete = false;
    started = true;
    render(0);
    playing = !reduced;
    updateControls();
    schedule();
  }

  function applyMotionPreference(event) {
    var shouldReduce = Boolean(event.matches);
    if (shouldReduce === reduced) return;
    reduced = shouldReduce;
    clearTimer();
    playing = false;
    if (reduced) {
      root.dataset.motion = 'reduced';
      complete = true;
      started = true;
      render(steps.length - 1);
    } else {
      delete root.dataset.motion;
      complete = false;
      started = false;
      render(0);
    }
    updateControls();
    if (!reduced && inView && !document.hidden) play();
  }

  toggle.addEventListener('click', function () {
    if (playing) pause();
    else play(true);
  });
  replay.addEventListener('click', function () {
    inView = true;
    root.dataset.visible = String(!document.hidden);
    restart();
  });
  document.addEventListener('visibilitychange', function () {
    root.dataset.visible = String(inView && !document.hidden);
    if (document.hidden) clearTimer();
    else schedule();
  });

  root.classList.add('is-enhanced');
  if (reduced) {
    root.dataset.motion = 'reduced';
    complete = true;
    started = true;
    render(steps.length - 1);
  } else {
    render(0);
  }
  updateControls();

  if (motionQuery) {
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', applyMotionPreference);
    else if (motionQuery.addListener) motionQuery.addListener(applyMotionPreference);
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      // isIntersecting works for tall demos in short or landscape viewports;
      // a percentage of the entire component can be impossible to expose.
      inView = entries[0].isIntersecting;
      root.dataset.visible = String(inView && !document.hidden);
      if (inView && !started && !reduced) play();
      else if (!inView) clearTimer();
      else schedule();
    }, { threshold: [0], rootMargin: '-10% 0px -10% 0px' }).observe(root);
  } else {
    inView = true;
    root.dataset.visible = 'true';
    if (!reduced) play();
  }
})();
