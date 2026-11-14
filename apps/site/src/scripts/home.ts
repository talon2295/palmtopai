import { bindFeedbackForm } from '../lib/feedback';

// Mockup: the last check gets marked as working, then goes back to not reviewed, in a loop.
const demoItem = document.getElementById('demo-item');
const demoCount = document.getElementById('demo-count');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!reducedMotion && demoItem && demoCount) {
    let reviewed = false;
    setInterval(() => {
        reviewed = !reviewed;
        demoItem.toggleAttribute('data-reviewed', reviewed);
        demoCount.textContent = reviewed ? '4/4 reviewed' : '3/4 reviewed';
    }, 3_500);
}

const feedbackForm = document.getElementById('feedback-form');
if (feedbackForm instanceof HTMLFormElement) bindFeedbackForm(feedbackForm);
