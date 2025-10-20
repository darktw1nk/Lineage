# Quick Start Guide

## 🚀 Get Started in 3 Steps

### 1. Install Dependencies

```bash
npm install
```

**Note**: This may take a few minutes. The installation includes:
- Electron and build tools
- React and UI libraries
- Database and security libraries (better-sqlite3, keytar)
- All TypeScript definitions

### 2. Configure API Keys (Optional for Testing)

You can start without API keys to explore the UI, but you'll need them to run actual evaluations.

When ready:
1. Run the app (see step 3)
2. Click **Settings** (bottom of left sidebar)
3. Go to **API Keys** tab
4. Enter your keys:
   - OpenAI: `sk-...`
   - Anthropic: `sk-ant-...`
   - Google Gemini: Your API key

**Tip**: Keys are stored securely in your OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)

### 3. Run the Application

```bash
npm run electron:dev
```

This will:
- Start Vite dev server (http://localhost:5173)
- Launch Electron window
- Enable hot reload for development

## 📋 Create Your First Evaluation

1. **Click "New Evaluation"** in the left sidebar

2. **Main Tab**:
   - Give it a name (e.g., "Test Run")
   - Set mutation factor: `0.5` (50% of offspring get mutations)
   - Set crossover factor: `0.3` (30% get crossovers)
   - Set top share: `0.4` (keep top 40% each generation)

3. **Population Tab**:
   - Initial size: `10` nodes
   - Seed prompt: Enter a prompt you want to optimize
   ```
   Example: "You are a helpful assistant. Answer concisely and accurately."
   ```
   - Fill mode: `Auto` (will generate variations)

4. **Models Tab**:
   - Check at least one model (e.g., `gpt-3.5-turbo` for quick testing)

5. **Test Set Tab**:
   - Click **Add Test**
   - Mode: `LLM Graded`
   - Test prompt: Enter a question/task
   ```
   Example: "What is 2+2? Provide only the number."
   ```

6. **Fitness Tab**:
   - Quality: `1.0` (will auto-normalize)
   - Toggle others as needed

7. **Targets Tab**:
   - Time limit: `5` minutes (for quick test)
   - Budget: `1` USD
   - Target fitness: `9.0`

8. **Click "Start Evaluation"**

## 👀 Watch the Magic

- **Center View**: Watch nodes appear and evolve
  - Green = finished, Blue = in progress, Gray = awaiting
  - Gold/Silver/Bronze borders = Top 3 performers

- **Click a Node**: Opens right panel with:
  - Full prompt text
  - Change log (mutations/crossovers applied)
  - Test results and scores
  - Metrics (fitness, cost, latency)

- **Footer**: Track progress
  - Current generation
  - Tokens used
  - Money spent
  - Cache hits (free API calls!)

- **Controls**:
  - **Pause**: Temporarily stop
  - **Stop**: End evaluation permanently

## 🎯 Understanding Results

### Node Colors
- **Green border**: Finished successfully
- **Blue border**: Currently running
- **Yellow border**: #3rd best
- **Silver border**: #2nd best  
- **Gold border**: #1 WINNER

### Fitness Score
Combined metric based on:
- **Quality**: How well it performs on tests (0-10)
- **Safety**: Guardrail compliance (optional)
- **Cost**: Lower tokens = higher score
- **Latency**: Faster = better
- **Stability**: Consistent across runs

### Change Log
See exactly what evolved:
- `[MUTATION]`: Small improvements
- `[CROSSOVER]`: Combined from 2 parents
- `[META]`: Targeted fixes based on failures
- `[PARAM]`: Temperature changes

## 💡 Pro Tips

1. **Start Small**: 
   - 5-10 nodes per generation
   - 1-2 simple tests
   - 5-10 minute time limit

2. **Use Caching**:
   - Identical (prompt + model + test) = cached
   - Watch cache hits in footer
   - Save money on repeated evaluations

3. **Monitor Costs**:
   - Check Settings → Model Costs
   - Adjust prices if using different tiers
   - Set budget limits to avoid surprises

4. **Iterate**:
   - Use winning prompt as seed for next run
   - Add more tests gradually
   - Increase population after initial success

## 🐛 Troubleshooting

### "No evaluation selected"
- Click an evaluation in left sidebar
- Or create new one

### Build errors
```bash
# Clean install
rm -rf node_modules dist dist-electron
npm install
```

### Electron won't start
- Check Node.js version: `node --version` (need 18+)
- On Windows: May need Visual Studio build tools for native modules

### API key not working
- Click Settings → API Keys
- Click the "Test" button (if available)
- Check console for errors

### Database errors
- App data location:
  - Windows: `%APPDATA%/evolution2/`
  - macOS: `~/Library/Application Support/evolution2/`
  - Linux: `~/.config/evolution2/`
- Delete `evolution.db` to reset

## 📚 Next Steps

- Read the full [README.md](./README.md)
- Review [technicalspecs.md](./technicalspecs.md) for architecture details
- Experiment with different operators and parameters
- Try meta-prompting for advanced optimization

## 🎉 Have Fun!

You're now ready to evolve some amazing prompts. Happy optimizing! 🧬

