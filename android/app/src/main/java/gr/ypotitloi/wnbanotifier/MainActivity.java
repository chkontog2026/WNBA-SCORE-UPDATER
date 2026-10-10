package gr.ypotitloi.wnbanotifier;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

public class MainActivity extends android.app.Activity {
    private static final String APP_URL = "https://wnba.ypotitloi.gr/";
    private static final String APP_HOST = "wnba.ypotitloi.gr";

    private WebView webView;
    private SwipeRefreshLayout refreshLayout;
    private int scrollYBeforeManualRefresh;
    private boolean restoreScrollAfterManualRefresh;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        refreshLayout = findViewById(R.id.refresh_layout);
        webView = findViewById(R.id.web_view);
        refreshLayout.setColorSchemeColors(Color.rgb(46, 101, 191), Color.rgb(233, 111, 34));
        refreshLayout.setOnRefreshListener(() -> {
            scrollYBeforeManualRefresh = webView.getScrollY();
            restoreScrollAfterManualRefresh = true;
            webView.reload();
        });

        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setUserAgentString(webView.getSettings().getUserAgentString() + " WNBA-Notifier-Android/1.0.1");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri destination = request.getUrl();
                if (APP_HOST.equalsIgnoreCase(destination.getHost())) {
                    return false;
                }
                startActivity(new Intent(Intent.ACTION_VIEW, destination));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                refreshLayout.setRefreshing(false);
                if (restoreScrollAfterManualRefresh) {
                    restoreScrollAfterManualRefresh = false;
                    view.post(() -> view.scrollTo(0, scrollYBeforeManualRefresh));
                }
            }
        });

        if (savedInstanceState == null) {
            refreshLayout.setRefreshing(true);
            webView.loadUrl(APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
