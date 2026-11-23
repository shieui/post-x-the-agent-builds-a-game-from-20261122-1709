// Star Catcher — a tiny one-prompt browser game.
// Move the basket, catch falling stars, don't let them hit the ground.
// States: "ready" -> "playing" -> "over". Autoplay (?autoplay=1) plays itself.
(function () {
  "use strict";

  var W = 1080;
  var H = 1920;
  var GROUND_Y = 1720;
  var BASKET_W = 260;
  var BASKET_H = 64;
  var START_LIVES = 3;

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var params = new URLSearchParams(location.search);
  var autoplay = params.get("autoplay") === "1";
  var GAME_SECONDS = 60;
  var secondsParam = parseInt(params.get("seconds") || "", 10);
  if (secondsParam > 0 && secondsParam <= 600) GAME_SECONDS = secondsParam;

  // Scale the fixed 1080x1920 playfield to fit the window, letterboxed.
  function fitCanvas() {
    var scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = Math.floor(W * scale) + "px";
    canvas.style.height = Math.floor(H * scale) + "px";
  }
  window.addEventListener("resize", fitCanvas);
  fitCanvas();

  var state = "ready"; // ready | playing | over
  var score = 0;
  var lives = START_LIVES;
  var timeLeft = GAME_SECONDS;
  var basketX = W / 2;
  var basketTarget = W / 2;
  var stars = [];
  var bursts = [];
  var spawnTimer = 0;
  var elapsed = 0;
  var bestCombo = 0;
  var combo = 0;
  var lastTick = 0;
  var keys = {};

  // --- helpers ------------------------------------------------------------

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function pickStarKind() {
    var roll = Math.random();
    if (roll < 0.16) return "pink"; // rare bonus star, 25 points
    if (roll < 0.30) return "blue"; // fast star, 15 points
    return "gold"; // 10 points
  }

  function spawnStar() {
    var kind = pickStarKind();
    var speed = rand(340, 460) + elapsed * 6;
    if (kind === "blue") speed *= 1.45;
    stars.push({
      x: rand(70, W - 70),
      y: -60,
      r: kind === "pink" ? 52 : 44,
      vy: speed,
      sway: rand(0, Math.PI * 2),
      swaySpeed: rand(0.8, 2.2),
      kind: kind,
      rot: rand(0, Math.PI * 2),
      rotSpeed: rand(-1.2, 1.2),
    });
  }

  function burst(x, y, color, count) {
    for (var i = 0; i < count; i++) {
      var angle = rand(0, Math.PI * 2);
      var speed = rand(120, 420);
      bursts.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 120,
        life: rand(0.35, 0.7),
        maxLife: 0.7,
        color: color,
        size: rand(6, 16),
      });
    }
  }

  // --- input ---------------------------------------------------------------

  function moveBasketTo(clientX) {
    var rect = canvas.getBoundingClientRect();
    var scale = W / rect.width;
    basketTarget = (clientX - rect.left) * scale;
  }

  window.addEventListener("keydown", function (e) {
    keys[e.key] = true;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
    }
    if (state === "ready" && (e.key === "Enter" || e.key === " ")) startGame();
    if (state === "over" && (e.key === "r" || e.key === "R" || e.key === "Enter")) resetGame();
  });
  window.addEventListener("keyup", function (e) {
    keys[e.key] = false;
  });
  canvas.addEventListener("pointerdown", function (e) {
    if (state === "ready") {
      startGame();
      return;
    }
    if (state === "over") {
      resetGame();
      return;
    }
    moveBasketTo(e.clientX);
  });
  canvas.addEventListener("pointermove", function (e) {
    if (e.buttons) moveBasketTo(e.clientX);
  });

  // --- game flow -----------------------------------------------------------

  function startGame() {
    state = "playing";
    score = 0;
    lives = START_LIVES;
    timeLeft = GAME_SECONDS;
    stars = [];
    bursts = [];
    elapsed = 0;
    combo = 0;
    bestCombo = 0;
    spawnTimer = 0;
    lastTick = performance.now();
  }

  function resetGame() {
    state = "ready";
    score = 0;
    lives = START_LIVES;
    timeLeft = GAME_SECONDS;
    stars = [];
    bursts = [];
    elapsed = 0;
    combo = 0;
    bestCombo = 0;
  }

  function endGame() {
    state = "over";
  }

  // --- update --------------------------------------------------------------

  function update(dt) {
    if (state !== "playing") return;

    elapsed += dt;
    timeLeft = Math.max(0, GAME_SECONDS - elapsed);
    if (timeLeft <= 0) {
      endGame();
      return;
    }

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnStar();
      spawnTimer = Math.max(0.22, 0.55 - elapsed * 0.004);
    }

    // Basket movement: keys, pointer, or autoplay chasing the lowest star.
    if (autoplay) {
      var target = null;
      var lowestY = -1;
      for (var i = 0; i < stars.length; i++) {
        if (stars[i].y > lowestY && stars[i].y < GROUND_Y) {
          lowestY = stars[i].y;
          target = stars[i];
        }
      }
      if (target) basketTarget = target.x;
    } else {
      if (keys["ArrowLeft"] || keys["a"] || keys["A"]) basketTarget -= 1400 * dt;
      if (keys["ArrowRight"] || keys["d"] || keys["D"]) basketTarget += 1400 * dt;
    }
    basketTarget = Math.max(BASKET_W / 2, Math.min(W - BASKET_W / 2, basketTarget));
    var diff = basketTarget - basketX;
    basketX += diff * Math.min(1, dt * 14);

    // Stars fall, sway and spin.
    for (var s = stars.length - 1; s >= 0; s--) {
      var star = stars[s];
      star.y += star.vy * dt;
      star.sway += star.swaySpeed * dt;
      star.x += Math.sin(star.sway) * 40 * dt;
      star.rot += star.rotSpeed * dt;

      var basketTop = GROUND_Y - BASKET_H;
      var caught =
        star.y + star.r >= basketTop &&
        star.y <= GROUND_Y + 10 &&
        Math.abs(star.x - basketX) < BASKET_W / 2 + star.r * 0.5;

      if (caught) {
        var points = star.kind === "pink" ? 25 : star.kind === "blue" ? 15 : 10;
        score += points;
        combo += 1;
        if (combo > bestCombo) bestCombo = combo;
        burst(star.x, star.y, starColor(star.kind), 14);
        stars.splice(s, 1);
        continue;
      }
      if (star.y - star.r > GROUND_Y + 40) {
        stars.splice(s, 1);
        lives -= 1;
        combo = 0;
        burst(star.x, GROUND_Y + 20, "#ff5a5a", 8);
        if (lives <= 0) {
          endGame();
          return;
        }
      }
    }

    // Particles fade.
    for (var b = bursts.length - 1; b >= 0; b--) {
      var p = bursts[b];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt;
      if (p.life <= 0) bursts.splice(b, 1);
    }
  }

  function starColor(kind) {
    if (kind === "pink") return "#ff7ad9";
    if (kind === "blue") return "#5ec8ff";
    return "#ffd23e";
  }

  // --- drawing ---------------------------------------------------------------

  function drawStar(x, y, r, rot, fill, stroke) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var radius = i % 2 === 0 ? r : r * 0.45;
      var angle = (i * Math.PI) / 5 - Math.PI / 2;
      var px = Math.cos(angle) * radius;
      var py = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground() {
    // Twinkling background stars.
    ctx.save();
    var t = performance.now() / 1000;
    for (var i = 0; i < 70; i++) {
      var bx = (i * 137.5) % W;
      var by = (i * 89.3) % 1500;
      var tw = 0.35 + 0.3 * Math.sin(t * 2 + i);
      ctx.globalAlpha = Math.max(0.1, tw);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(bx, by, 3 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // Moon.
    ctx.save();
    ctx.fillStyle = "#fff6c9";
    ctx.beginPath();
    ctx.arc(880, 430, 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f2e3a1";
    ctx.beginPath();
    ctx.arc(850, 410, 18, 0, Math.PI * 2);
    ctx.arc(905, 455, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Ground.
    ctx.fillStyle = "#171233";
    ctx.fillRect(0, GROUND_Y + 40, W, H - GROUND_Y - 40);
    ctx.fillStyle = "#241b4d";
    ctx.fillRect(0, GROUND_Y + 40, W, 10);
  }

  function drawHud() {
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 96px 'DejaVu Sans', sans-serif";
    ctx.fillText(String(score), 60, 60);
    ctx.font = "bold 40px 'DejaVu Sans', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText("SCORE", 64, 170);

    // Timer bar, top centre-right.
    var barW = 420;
    var barX = W - barW - 60;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(barX, 78, barW, 34, 17);
    ctx.fill();
    ctx.fillStyle = timeLeft <= 10 ? "#ff5a5a" : "#5ec8ff";
    var frac = timeLeft / GAME_SECONDS;
    roundRect(barX, 78, Math.max(34, barW * frac), 34, 17);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 52px 'DejaVu Sans', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(Math.ceil(timeLeft) + "s", W - 60, 130);

    // Lives as hearts.
    ctx.textAlign = "left";
    ctx.font = "64px 'DejaVu Sans', sans-serif";
    var hearts = "";
    for (var i = 0; i < START_LIVES; i++) {
      hearts += i < lives ? "♥" : "♡";
    }
    ctx.fillStyle = "#ff5a7a";
    ctx.fillText(hearts, 60, 240);
    ctx.restore();
  }

  function drawBasket() {
    var top = GROUND_Y - BASKET_H;
    ctx.save();
    // Basket body.
    ctx.fillStyle = "#ff8a3d";
    roundRect(basketX - BASKET_W / 2, top, BASKET_W, BASKET_H, 26);
    ctx.fill();
    ctx.fillStyle = "#ffb347";
    roundRect(basketX - BASKET_W / 2, top, BASKET_W, 22, 11);
    ctx.fill();
    // Rim.
    ctx.fillStyle = "#e56b1f";
    roundRect(basketX - BASKET_W / 2 - 14, top - 14, BASKET_W + 28, 30, 15);
    ctx.fill();
    // Weave lines.
    ctx.strokeStyle = "rgba(120,40,0,0.35)";
    ctx.lineWidth = 5;
    for (var i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(basketX + i * 70, top + 8);
      ctx.lineTo(basketX + i * 70, top + BASKET_H - 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCenter(text, sub, color) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(8, 10, 30, 0.72)";
    roundRect(90, 620, W - 180, 560, 48);
    ctx.fill();
    ctx.fillStyle = color || "#ffffff";
    ctx.font = "bold 110px 'DejaVu Sans', sans-serif";
    ctx.fillText(text, W / 2, 800);
    if (sub) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "44px 'DejaVu Sans', sans-serif";
      var lines = sub.split("\n");
      for (var i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], W / 2, 920 + i * 64);
      }
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawBackground();
    if (state === "ready") {
      drawCenter("STAR CATCHER", "One prompt. One game.\nTap or press Enter to play", "#ffd23e");
      drawBasket();
      return;
    }
    for (var i = 0; i < stars.length; i++) {
      var star = stars[i];
      var fill = starColor(star.kind);
      var stroke = star.kind === "pink" ? "#c2188b" : star.kind === "blue" ? "#1d6fb8" : "#c78d00";
      drawStar(star.x, star.y, star.r, star.rot, fill, stroke);
    }
    for (var j = 0; j < bursts.length; j++) {
      var p = bursts[j];
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    drawBasket();
    drawHud();
    if (state === "over") {
      var verdict = score >= 200 ? "STAR CHAMPION!" : score >= 100 ? "NICE CATCHING!" : "GAME OVER";
      drawCenter(
        verdict,
        "Final score: " + score + "\nBest combo: " + bestCombo + "\nPress R to play again",
        "#ffd23e"
      );
    }
  }

  // --- main loop --------------------------------------------------------------

  function frame(now) {
    var dt = Math.min(0.05, (now - lastTick) / 1000 || 0.016);
    lastTick = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  lastTick = performance.now();
  requestAnimationFrame(frame);
  if (autoplay) startGame();
})();
