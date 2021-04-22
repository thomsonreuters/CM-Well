<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:atom="http://www.w3.org/2005/Atom">
    <!--
            Note about the reason the XPath-Selectors below not being concise:

            You will see below many "atom:" ns prefixes. Many. This is because XPath1.0 doesn't support default namespace.
            There is a "xpath-default-namespace" attribute in XPath2.0 (and correspondingly in XSLT2.0), however, browsers do not support XSLT2.0 natively.
    -->
    <xsl:template match="/">
        <html>
            <head>
                <link rel="stylesheet" type="text/css" href="/meta/app/angular/style/atom.css" />
                <base target="_blank"/>
            </head>
            <body>
                <i>Updated: <xsl:value-of select="atom:feed/atom:updated"/></i><br/>

                Author:
                <a>
                    <xsl:attribute name="href"><xsl:value-of select="atom:feed/atom:author/atom:uri"/></xsl:attribute>
                    <xsl:value-of select="atom:feed/atom:author/atom:uri"/>
                </a>
                <br/>

                <h1><xsl:value-of select="atom:feed/atom:title"/></h1>
                <h2><xsl:value-of select="atom:feed/atom:subtitle"/></h2>

                <div class="entries">
                    <xsl:for-each select="/atom:feed/atom:entry">
                        <div class="entry">
                            <b><xsl:value-of select="atom:title"/></b><br/>
                            <xsl:for-each select="atom:link">
                                <xsl:if test="contains(@href, '/ii/')">Point in time </xsl:if>URL:
                                <a>
                                    <xsl:attribute name="href"><xsl:value-of select="@href"/></xsl:attribute>
                                    <xsl:value-of select="@href"/>
                                </a>
                                <br/>
                            </xsl:for-each>
                            <br/>
                            Updated: <xsl:value-of select="atom:updated"/><br/>
                            <xsl:if test="atom:content">
                                Content: <pre class="content"><xsl:value-of select="atom:content"/></pre><br/>
                            </xsl:if>
                        </div>
                    </xsl:for-each>
                </div>
            </body>
        </html>
    </xsl:template>
</xsl:stylesheet>